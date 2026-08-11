import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The tab shell is split on purpose: activation lives in the inline
// <DashTabsBoot /> script so a tab responds before the page's JS bundle lands
// (the seller dashboard's is ~61 KB gzipped — on a weak mobile connection that
// was seconds of a page that looked ready and answered nothing). initDashTabs()
// keeps only the module-dependent extras and calls window.__dashTabActivate.
//
// The failure mode that split creates: a page renders a tab strip and forgets
// the boot, and the strip is simply dead — no error anywhere, and it looks fine
// on a fast connection because nothing else switches tabs either. So: any page
// with a [role="tab"][data-panel] strip MUST render <DashTabsBoot />.

const PAGES_DIR = join(process.cwd(), 'src/pages');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.astro') ? [full] : [];
  });
}

describe('DashTabsBoot', () => {
  it('is rendered by every page that renders a dash-tabs strip', () => {
    const missing = walk(PAGES_DIR).filter((file) => {
      const src = readFileSync(file, 'utf8');
      const hasStrip = /role="tab"/.test(src) && /data-panel=/.test(src);
      return hasStrip && !src.includes('<DashTabsBoot');
    });

    expect(missing.map((f) => f.replace(process.cwd() + '/', ''))).toEqual([]);
  });

  it('keeps activation in ONE place — ui.ts must not re-implement it', () => {
    const ui = readFileSync(join(process.cwd(), 'src/scripts/dashboard/ui.ts'), 'utf8');
    // A second copy silently drifts from the inline one, and every tab click
    // would run both. initDashTabs() delegates instead.
    expect(ui).toContain('__dashTabActivate');
    expect(ui).not.toMatch(/dispatchEvent\(new CustomEvent\('dashtab:show'/);
  });

  it('reveals a tab by scrolling the STRIP, never the page', () => {
    // `.seller-dash .dash-tabs` is position:sticky, and scrollIntoView targets an
    // element's STATIC position — so bringing the active tab "into view" scrolled
    // the whole document up to where the strip sits unstuck. On a refresh, which
    // restores the seller's scroll, that was a visible jump down→up→down (owner,
    // 2026-07-31, Performance tab). Both call sites must use __dashTabReveal.
    const files = ['src/components/dashboard/DashTabsBoot.astro', 'src/scripts/dashboard/ui.ts'];
    for (const rel of files) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ''), rel).not.toMatch(/dash-tab[^\n]*scrollIntoView|scrollIntoView[^\n]*\{\s*block/);
    }
    // One implementation of "where does the strip sit", in the boot: ui.ts asks
    // for it rather than measuring the strip itself.
    const boot = readFileSync(join(process.cwd(), 'src/components/dashboard/DashTabsBoot.astro'), 'utf8');
    const ui = readFileSync(join(process.cwd(), 'src/scripts/dashboard/ui.ts'), 'utf8');
    expect(boot).toContain('window.__dashTabReveal = function');
    expect(ui).toContain('__dashTabRestore');
  });

  it('re-asserts the open tab\'s position after the browser restores the strip', () => {
    // A reload restores a scroller's own offset on the browser's schedule (after
    // layout, around `load`), so a position written at parse time is overwritten
    // a few frames later — the strip came back wherever it sat when the seller
    // pressed refresh, which with a different panel open leaves the tab they are
    // ON off screen (owner, 2026-08-11). Placing it once is therefore a race, and
    // one that only loses on the machines that lay out slowest.
    const boot = readFileSync(join(process.cwd(), 'src/components/dashboard/DashTabsBoot.astro'), 'utf8');
    expect(boot).toMatch(/addEventListener\('load', restoreSoon\)/);
    expect(boot).toMatch(/document\.fonts\.ready/); // the tabs resize when Heebo swaps in
    // …and stops the moment the seller takes over: a re-assert on top of their
    // own scroll is the page pulling the strip out from under them.
    expect(boot).toContain('data-tab-scrolled');
    // `scroll` must never be the off switch — our own writes and the browser's
    // restoration both fire it, so listening for it would disarm the restore
    // before it ever ran.
    expect(boot).not.toMatch(/addEventListener\('scroll'/);
  });

  it('keeps the open tab clear of the edge fades, not merely inside the box', () => {
    // The fade dissolves whatever reaches the strip's edge, so a tab landed flush
    // there is the tab the seller is on, half washed out — "visible" by geometry
    // and unreadable in fact. The reveal insets its target band on any side that
    // still has strip to scroll (a fully-scrolled side lights no fade and gets no
    // inset, so the first and last tabs still rest flush).
    const boot = readFileSync(join(process.cwd(), 'src/components/dashboard/DashTabsBoot.astro'), 'utf8');
    expect(boot).toMatch(/hidden\.left > 1 \? inset : 0/);
    expect(boot).toMatch(/hidden\.right > 1 \? inset : 0/);
    // RTL runs scrollLeft from -max to 0 and its start is the RIGHT edge, so the
    // two hidden amounts swap — reading them off scrollLeft directly would inset
    // the wrong side on this site's own language.
    expect(boot).toMatch(/rtl \? \{ left: max - sl, right: sl \} : \{ left: sl, right: max - sl \}/);
  });

  it('does not re-activate the tab the server already opened', () => {
    // ?panel=… is server-rendered as the open tab, so clicking it on load was a
    // no-op the seller could see — it fired during the browser's scroll
    // restoration. Only a deep link that disagrees with the DOM may click.
    const page = readFileSync(join(process.cwd(), 'src/pages/seller/dashboard.astro'), 'utf8');
    expect(page).toMatch(/!tabBtn\.classList\.contains\('dash-tab--active'\)\)\s*tabBtn\.click\(\)/);
  });

  it('treats ?panel= as untrusted — validated server-side, escaped in the selector', () => {
    // Every panel renders `hidden={initialPanel !== <name>}`, so an unknown value
    // hid all of them and served an empty dashboard; and the raw value was
    // interpolated into a querySelector, where a quote throws a DOMException and
    // kills every init call after it (crop modal, cleanup modal, …).
    const page = readFileSync(join(process.cwd(), 'src/pages/seller/dashboard.astro'), 'utf8');
    expect(page).toMatch(/PANEL_NAMES[\s\S]{0,200}includes\(requestedPanel\)/);
    expect(page).toContain('data-panel="${CSS.escape(panel)}"');
  });

  it('stops the waiting pulse BEFORE replaying the click, not after', () => {
    // A menu trigger tapped before its panel's JS arrived gets [data-opening]
    // (it pulses) and its click is replayed on hydration. Clearing the pulse
    // after `.click()` looked equivalent and was not: the replayed handler is
    // panel code, and whatever it did left the attribute in place — the control
    // pulsed forever behind an open menu (caught 2026-07-31 by measuring, after
    // the code read as correct).
    const page = readFileSync(join(process.cwd(), 'src/pages/seller/dashboard.astro'), 'utf8');
    const clear = page.indexOf("removeAttribute('data-opening')");
    const replay = page.indexOf('replay.click()');
    expect(clear, 'the pulse must be cleared').toBeGreaterThan(-1);
    expect(replay, 'the click must be replayed').toBeGreaterThan(-1);
    expect(clear).toBeLessThan(replay);
  });

  it('the boot script is inline — a network fetch would defeat the whole point', () => {
    const boot = readFileSync(join(process.cwd(), 'src/components/dashboard/DashTabsBoot.astro'), 'utf8');
    expect(boot).toContain('<script is:inline>');
    expect(boot).not.toMatch(/\bimport\s/);
  });
});
