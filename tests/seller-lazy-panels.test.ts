import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The seller dashboard renders ONE panel's data per request and fills the other nine on the click
 * that opens them (SELLER_LAZY_PANELS_PLAN.md, 2026-08-11). The twin of
 * `tests/admin-lazy-panels.test.ts`, and it exists for the same reason: several mechanisms address
 * a panel by its element id, and every way this contract can slip fails SILENTLY — a tab that opens
 * empty, a badge that stops appearing, a form whose draft is no longer kept. None of them throws,
 * so none of them shows up anywhere but here.
 *
 * Everything is a source scan rather than a render, because what is being pinned is a decision
 * ("this read is gated, that one is not") and not an output.
 */

const ROOT = process.cwd();
const PAGE = path.join(ROOT, 'src/pages/seller/dashboard.astro');
const SHELL = path.join(ROOT, 'src/components/dashboard/SellerPanelShell.astro');

const read = (file: string) => fs.readFileSync(file, 'utf8');

/** The panel list, as the page declares it. Read from the source so a new tab joins these
 *  assertions by existing rather than by someone remembering to list it here. */
function declaredPanels(): string[] {
  const source = read(PAGE);
  const block = /const PANEL_NAMES = \[([^\]]*)\] as const;/.exec(source);
  expect(block, 'the panel list moved — this file reads it out of the page').toBeTruthy();
  return [...block![1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
}

describe('every tab has a shell, and only one is filled', () => {
  it('renders a SellerPanelShell for every declared panel', () => {
    const shells = [...read(PAGE).matchAll(/<SellerPanelShell panel="([a-z]+)"/g)].map((m) => m[1]!);
    expect(shells.sort()).toEqual(declaredPanels().sort());
  });

  it('gates every shell on the panel being the one asked for', () => {
    // `active` decides three things at once: `hidden`, whether `data-lazy` is set, and whether the
    // contents render at all. A shell with `active={true}` hardcoded would put its tab's markup back
    // into every response — the thing this change removed.
    const actives = [...read(PAGE).matchAll(/<SellerPanelShell panel="[a-z]+" active=\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(actives).toHaveLength(declaredPanels().length);
    for (const expr of actives) expect(expr).toMatch(/^shows\('/);
  });
});

describe('the shell keeps the contract the rest of the dashboard relies on', () => {
  const shell = read(SHELL);

  it('always renders the container, with the id every other mechanism addresses', () => {
    expect(shell).toContain('id={`dash-panel-${panel}`}');
    expect(shell).toContain('role="tabpanel"');
    // `aria-labelledby` is not decoration here: unsaved-guard.ts finds a tab's panel through it.
    expect(shell).toContain('aria-labelledby={`tab-${panel}`}');
    // `hidden`, not a conditional render: the element has to be in the document either way.
    expect(shell).toContain('hidden={!active}');
  });

  it('marks a closed panel data-lazy and an open one not', () => {
    expect(shell).toContain("data-lazy={active ? undefined : ''}");
  });

  it('shows a STATIC placeholder — no ambient looping motion on nine hidden panels', () => {
    expect(shell).not.toMatch(/animate-|animation|infinite/);
  });
});

describe('the panel filler', () => {
  const page = read(PAGE);

  it('claims the panel before fetching, so a double click cannot start two loads', () => {
    const removal = page.indexOf("el.removeAttribute('data-lazy')");
    const fetchCall = page.indexOf('return swapPanel(');
    expect(removal).toBeGreaterThan(-1);
    expect(removal).toBeLessThan(fetchCall);
  });

  it('asks for the panel with no other tab\'s params attached', () => {
    // Anything else in the address bar when a lazy panel opens belongs to the tab being LEFT. The
    // store is not "another tab's param" — it is which shop the whole dashboard is showing.
    expect(page).toContain("const params = new URLSearchParams({ panel });");
    expect(page).toMatch(/params\.set\('store', storeId\)/);
  });

  it('does not push its own history entry — the tab strip already wrote the URL', () => {
    // DashTabsBoot replaceState()s `?panel=` on activation. A push from the fill would leave a
    // second entry for the same place, so Back would have to be pressed twice.
    expect(page).toMatch(/\{ busy: false, pushUrl: false \}/);
  });

  it('wires a panel only after BOTH its HTML and its chunk have landed', () => {
    // The ordering bug this exists to prevent: every `init*` binds against elements that must
    // already exist, and the wiring runs once — so wiring before the fill wires nothing, forever.
    expect(page).toMatch(/Promise\.all\(\[fillPanel\(panel\), panelChunk\(panel\)\]\)\s*\n?\s*\.then\(\(\[, wire\]\) => \{ wire\(\); \}\)/);
  });

  it('idle-prefetches CHUNKS, never a wiring pass over an empty shell', () => {
    // `hydrate` here would spend each panel's one wiring on a container that has no contents yet.
    const idle = /idle\(\(\) => \{([\s\S]*?)\}\);/.exec(page);
    expect(idle, 'the idle prefetch moved').toBeTruthy();
    expect(idle![1]).toContain('panelChunk(');
    expect(idle![1]).not.toContain('hydrate(');
  });

  it('every loader returns its wiring rather than running it', () => {
    // The two-phase shape IS the fix. A loader that still wired inline would run against whatever
    // the panel held at import time, which for nine of ten panels is a placeholder.
    expect(page).toContain('const LOADERS: Record<string, () => Promise<() => void>> = {');
  });

  it('re-wires the shell-owned controls inside the panel that just arrived', () => {
    // The settings form, the add-product toggle, the hours editor, the overview's jump cards, the
    // tooltips and the discount readouts are bound by the page's stage-1 script — which ran before
    // any of those elements existed.
    expect(page).toMatch(/swapPanel\([^;]*el\.id, \(\) => \{\s*\n\s*wireSharedControls\(el\);/);
    for (const call of ['initSettingsForm()', 'initFormToggles()', 'initStoreHours()', 'initGotoPanelLinks()', 'initInfoTooltips(root)', 'refreshDiscountFieldsIn(root)']) {
      expect(page, `${call} has to run again for a panel filled after load`).toContain(call);
    }
  });

  it('gives the draft guard the forms that arrived with the panel — and only those', () => {
    // Without this a crash loses work typed into any tab but the one the page was opened on, and
    // nothing anywhere reports it (project_dashboard_draft_recovery).
    //
    // Scoped to the filled panel, never `document`: this module is deferred, so a load-time scan
    // would run BEFORE the guard's own `DOMContentLoaded` pass — which resets its offer table
    // without removing the bars an earlier scan inserted, leaving two identical "restore your
    // draft?" bars in one form.
    expect(page).toContain('window.__dashScanDrafts?.(el)');
    expect(page).not.toContain('window.__dashScanDrafts?.(root)');
    expect(page).not.toContain('window.__dashScanDrafts?.(document)');
    const guard = read(path.join(ROOT, 'src/components/dashboard/FormFallbackGuard.astro'));
    expect(guard).toContain('window.__dashScanDrafts = function (root)');
    // Additive: a form already being typed into on a visible panel must not have its baseline
    // retaken by a panel opening somewhere else.
    expect(guard).toMatch(/if \(form\.hasAttribute\('data-draft-live'\)\) continue;/);
  });
});

describe('a badge reports a tab you are NOT looking at, so it is never gated', () => {
  const page = read(PAGE);

  /** The `only(...)` wrapper is what skips a read for a panel that is not being rendered. A badge
   *  read wrapped in it would leave the dot silently absent on every other tab. */
  const gated = (fn: string): boolean =>
    new RegExp(String.raw`only\((?:[^\n]*?)${fn}\s*\(`).test(page);

  it.each([
    ['countStockAlerts', 'the Products tab\'s stock-alert badge'],
    ['getSellerOrderStatusCounts', 'the Orders tab\'s "(N) new" badge'],
    ['getUnreadThreadIdsForSeller', 'the Messages tab\'s unread dot'],
    ['getUnreadAdminThreadIdsForSeller', 'the same dot, for system threads'],
    ['getSellerAccountFor', 'the Payments tab\'s "no bank account" dot'],
    ['getProductCountsByStore', 'the first-steps checklist, which decides the per-tab hints'],
  ])('%s stays ungated — %s', (fn) => {
    expect(page, `${fn}() is called somewhere on this page`).toContain(`${fn}(`);
    expect(gated(fn)).toBe(false);
  });

  it('and the panel-sized reads ARE gated', () => {
    // The other half of the same statement: if none of these were wrapped, the page would still be
    // building all ten panels and the badge assertions above would be vacuously true.
    for (const fn of ['getProductsByStoreId', 'getWishlistCountsForStore', 'getSellerOrdersPage', 'getThreadRootsBySeller', 'openOrderCount']) {
      expect(gated(fn), `${fn}() belongs to one panel and should be behind only()`).toBe(true);
    }
  });

  it('the platform-wide category vocabulary is read for two surfaces, not on every load', () => {
    // The one read here that is not about this seller's own shop — it walks every visible store on
    // the platform, and it feeds the create-a-store card and the settings picker only.
    expect(page).toMatch(/\(showCreateStore \|\| shows\('settings'\)\) \? await getVisibleStores\(\) : \[\]/);
  });
});
