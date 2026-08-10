import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The admin dashboard renders ONE panel's data per request and loads the other ten on the click
 * that opens them (owner, 2026-08-07). Three separate mechanisms address a panel by its element id
 * and quietly stop working if that contract slips, so it is asserted on the source rather than
 * trusted:
 *
 *   · `DashTabsBoot` toggles `hidden` on `#dash-panel-<id>` — the element must exist for all eleven;
 *   · `swapPanel` replaces that element's `innerHTML` — same;
 *   · `wirePanelLinks` binds ONE delegated listener to it that has to survive every swap — so the
 *     container is server-rendered even while empty, and only its contents are conditional.
 *
 * Everything here is a source scan for the same reason the badge guard is: the failure mode is a
 * panel that opens empty and stays empty, which raises nothing.
 */

const ROOT = process.cwd();
const ADMIN_PAGE = path.join(ROOT, 'src/pages/admin/index.astro');
const SHELL = path.join(ROOT, 'src/components/admin/AdminPanelShell.astro');
const LAZY = path.join(ROOT, 'src/scripts/admin/lazy-panels.ts');

const read = (file: string) => fs.readFileSync(file, 'utf8');

/** The tab strip, as the page declares it. Read from the source so a new tab joins these
 *  assertions by existing rather than by someone remembering to list it here. */
function declaredPanels(): string[] {
  const source = read(ADMIN_PAGE);
  const block = /const tabs = \[([\s\S]*?)\] as const;/.exec(source);
  expect(block, 'the tab list moved — this file reads it out of the page').toBeTruthy();
  return [...block![1]!.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]!);
}

describe('every tab has a shell, and only one is filled', () => {
  it('renders an AdminPanelShell for every declared tab', () => {
    const source = read(ADMIN_PAGE);
    const shells = [...source.matchAll(/<AdminPanelShell panel="([a-z]+)"/g)].map((m) => m[1]!);
    expect(shells.sort()).toEqual(declaredPanels().sort());
  });

  it('gates every shell on the panel being the one asked for', () => {
    // `active` decides three things at once: `hidden`, whether `data-lazy` is set, and whether the
    // contents render at all. A shell with `active={true}` hardcoded would put its tab's data back
    // on every request — the thing this change removed.
    const source = read(ADMIN_PAGE);
    const actives = [...source.matchAll(/<AdminPanelShell panel="[a-z]+" active=\{([^}]*(?:\}[^}]*)*?)\}>/g)].map((m) => m[1]!);
    expect(actives).toHaveLength(declaredPanels().length);
    for (const expr of actives) {
      expect(expr, 'a shell must be gated on shows() or on data that is only loaded for it')
        .toMatch(/shows\('|^!!/);
    }
  });

  it('short-circuits the panel component so its props are never evaluated for a tab that is closed', () => {
    // Astro evaluates a slot child's PROPS at the call site, not when the shell decides to render
    // it. Passing `sellersTab!.cards` into a closed panel therefore throws on null — which it did,
    // as a 500 on every /admin request, until each body was wrapped in its own `&&`.
    const source = read(ADMIN_PAGE);
    for (const [, data, component] of source.matchAll(/\{(\w+) && (?:\w+ && )*<(Admin\w+Panel)/g)) {
      expect(data, component).toBeTruthy();
    }
    for (const nullable of ['sellersTab', 'ordersPage', 'threadsPage', 'moneyLog', 'performanceTab', 'advertisingTab']) {
      expect(source, `${nullable} is null for every other tab — its panel body must be guarded`)
        .toMatch(new RegExp(`\\{${nullable}(?: && \\w+)* && <Admin`));
    }
  });
});

describe('the shell keeps the contract the rest of the dashboard relies on', () => {
  const shell = read(SHELL);

  it('always renders the container, with the id every other mechanism addresses', () => {
    expect(shell).toContain('id={`dash-panel-${panel}`}');
    expect(shell).toContain('role="tabpanel"');
    // `hidden`, not a conditional render: the element has to be in the document either way.
    expect(shell).toContain('hidden={!active}');
  });

  it('marks a closed panel data-lazy and an open one not', () => {
    expect(shell).toContain("data-lazy={active ? undefined : ''}");
  });

  it('shows a STATIC placeholder — no ambient looping motion on ten hidden panels', () => {
    expect(shell).not.toMatch(/animate-|animation|infinite/);
  });
});

describe('the loader', () => {
  const lazy = read(LAZY);

  it('claims the panel before fetching, so a double click cannot start two loads', () => {
    const removal = lazy.indexOf("removeAttribute('data-lazy')");
    const fetchCall = lazy.indexOf('swapPanel(');
    expect(removal).toBeGreaterThan(-1);
    expect(removal).toBeLessThan(fetchCall);
  });

  it('asks for the panel with no other tab\'s params attached', () => {
    // Anything in the address bar when a lazy panel opens belongs to the tab being LEFT.
    expect(lazy).toContain('buildAdminUrl(panel, {})');
  });

  it('has a wiring entry for every tab that has client-side controls', () => {
    const wired = [...lazy.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);
    // ⚠️ `overview` and `attention` are here because they have nothing to wire — and NOT, as an
    // earlier version of this comment claimed, because some shared container handler covers their
    // pagers. There is no such handler: `wirePanelLinks` is called BY each panel's own module, so a
    // panel with no module has no interception and its links navigate for real. `attention`'s pager
    // does reload the page today. That is a known cost, not a mechanism.
    // A panel with a pager therefore needs an entry — `payouts` has one for exactly this reason.
    const NOTHING_TO_WIRE = ['overview', 'attention'];
    for (const panel of declaredPanels().filter((p) => !NOTHING_TO_WIRE.includes(p))) {
      expect(wired, panel).toContain(panel);
    }
  });
});
