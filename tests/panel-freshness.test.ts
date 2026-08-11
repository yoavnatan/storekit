// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  PANEL_STALE_MS,
  markPanelFresh,
  isPanelStale,
  invalidatePanel,
  panelHoldsTypedText,
} from '../src/lib/panel-freshness.js';

/**
 * Opening a tab shows current data (owner, 2026-08-11). Two halves are asserted here, and they fail
 * in opposite directions — which is why neither is left to a reading of the code:
 *
 *  · the staleness window itself. Too eager and every switch between two tabs is a round trip; too
 *    lazy and the feature does not exist. Neither shows up on screen as a fault, so nothing but a
 *    test would notice the constant drifting.
 *  · the refusal to refresh over typed text. This one is a DATA LOSS bug the moment it regresses,
 *    and the only symptom is a user's half-written note disappearing when they come back to it —
 *    which they will report as "it deleted what I wrote", not as a caching problem.
 */

describe('the staleness window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invalidatePanel('p');
  });
  afterEach(() => vi.useRealTimers());

  it('treats a panel that has never loaded as stale', () => {
    expect(isPanelStale('never-loaded')).toBe(true);
  });

  it('holds a freshly-stamped panel fresh for the whole window', () => {
    markPanelFresh('p');
    expect(isPanelStale('p')).toBe(false);
    vi.advanceTimersByTime(PANEL_STALE_MS - 1);
    expect(isPanelStale('p')).toBe(false);
  });

  it('goes stale once the window has elapsed', () => {
    markPanelFresh('p');
    vi.advanceTimersByTime(PANEL_STALE_MS);
    expect(isPanelStale('p')).toBe(true);
  });

  it('lets a caller force the next open to refresh', () => {
    markPanelFresh('p');
    invalidatePanel('p');
    expect(isPanelStale('p')).toBe(true);
  });

  it('keeps panels independent — one going stale must not refresh the others', () => {
    markPanelFresh('a');
    vi.advanceTimersByTime(PANEL_STALE_MS);
    markPanelFresh('b');
    expect(isPanelStale('a')).toBe(true);
    expect(isPanelStale('b')).toBe(false);
  });

  it('stays inside the pollers it shares the page with', () => {
    // Seller + admin badges both poll on a 15s timer. A window shorter than that would put a panel
    // refresh on the wire alongside a poll that had just answered the same question.
    expect(PANEL_STALE_MS).toBeGreaterThanOrEqual(15_000);
    // And an upper bound, because "stale" has to mean something a person would notice.
    expect(PANEL_STALE_MS).toBeLessThanOrEqual(120_000);
  });
});

describe('never refreshing over typed text', () => {
  function panel(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  }

  it('is quiet for a panel with no fields at all', () => {
    expect(panelHoldsTypedText(panel('<p>nothing here</p>'))).toBe(false);
  });

  it('is quiet for a missing panel', () => {
    expect(panelHoldsTypedText(null)).toBe(false);
  });

  it('is quiet for a field left exactly as the server rendered it', () => {
    expect(panelHoldsTypedText(panel('<input value="דני">'))).toBe(false);
  });

  it('blocks the refresh once a field differs from what the server rendered', () => {
    const el = panel('<input value="דני">');
    el.querySelector('input')!.value = 'דני כהן';
    expect(panelHoldsTypedText(el)).toBe(true);
  });

  it('blocks on a half-written textarea', () => {
    const el = panel('<textarea></textarea>');
    el.querySelector('textarea')!.value = 'הודעה שלא נשלחה';
    expect(panelHoldsTypedText(el)).toBe(true);
  });

  it('blocks on a checkbox the user toggled', () => {
    const el = panel('<input type="checkbox">');
    el.querySelector('input')!.checked = true;
    expect(panelHoldsTypedText(el)).toBe(true);
  });

  // Three fields whose value moving is not a person editing anything. The last is the load-bearing
  // one: a live search box's text is part of the request the refresh is about to send, so counting
  // it would freeze the panel from the first character ever typed into it.
  it.each([
    ['a button, whose value is a label and not an edit', '<input type="submit" value="שמור">', 'משהו אחר'],
    ['a disabled field', '<input value="a" disabled>', 'b'],
    ['a field that opts out because the refresh carries it', '<input data-freshness-ignore value="">', 'חיפוש'],
  ])('ignores %s', (_name, html, typed) => {
    const el = panel(html);
    el.querySelector('input')!.value = typed;
    expect(panelHoldsTypedText(el)).toBe(false);
  });
});

/**
 * The wiring, scanned in the source: the rule above is only worth anything if the two dashboards
 * actually ask it before replacing a panel's contents, and a refresh that forgot to is a silent
 * regression — the panel simply refreshes, and the data loss shows up on somebody else's screen.
 */
describe('both dashboards consult the rule before replacing a panel', () => {
  const ROOT = process.cwd();
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  it('the admin re-open path checks staleness AND typed text', () => {
    const src = read('src/scripts/admin/lazy-panels.ts');
    expect(src).toMatch(/panelHoldsTypedText\(el\)/);
    expect(src).toMatch(/isPanelStale\(el\.id\)/);
  });

  it('the admin re-open keeps the panel\'s own filter params', () => {
    // A re-open that dropped them would look like the dashboard forgetting the admin's filter.
    const src = read('src/scripts/admin/lazy-panels.ts');
    expect(src).toMatch(/stripForeignTabParams\(new URL\(location\.href\), panel\)/);
  });

  it('every admin panel swap stamps itself fresh, from the one place they all funnel through', () => {
    // Stamping at call sites instead would be a list to remember to update — the failure mode is a
    // panel that re-fetches on every single open because nothing ever marked it loaded.
    const src = read('src/lib/admin-nav.ts');
    expect(src).toMatch(/markPanelFresh\(panelId\)/);
  });

  it('the buyer dashboard checks the same rule before refreshing a tab', () => {
    const src = read('src/pages/buyer/dashboard.astro');
    expect(src).toMatch(/panelHoldsTypedText\(panel\)/);
    expect(src).toMatch(/isPanelStale\(`buyer:\$\{key\}`\)/);
  });

  it('no server-side code stamps a panel fresh', () => {
    // The stamp Map lives in the module, so a call from a route or from `.astro` frontmatter would
    // be shared across every request and every admin — one person's tab switch deciding whether
    // another person's refreshes. Browser code only.
    const serverDirs = ['src/pages/api', 'src/jobs', 'src/middleware.ts'];
    for (const dir of serverDirs) {
      const target = path.join(ROOT, dir);
      if (!fs.existsSync(target)) continue;
      const files = fs.statSync(target).isDirectory()
        ? fs.readdirSync(target, { recursive: true, encoding: 'utf8' }).map((f) => path.join(target, f))
        : [target];
      for (const f of files) {
        if (!/\.(ts|astro)$/.test(f) || !fs.statSync(f).isFile()) continue;
        expect(fs.readFileSync(f, 'utf8'), `${f} must not write per-document freshness state`)
          .not.toContain('markPanelFresh');
      }
    }
  });

  it('the buyer orders panel writes all three counts from one response', () => {
    // Sidebar and both sub-tabs report the same two numbers. Refreshing some of them would swap
    // "all three are stale" for "they disagree", which is the worse of the two.
    const src = read('src/pages/buyer/dashboard.astro');
    for (const id of ['nav-orders-count', 'o-count-active', 'o-count-history']) {
      expect(src, `${id} must be written by applyOrderCounts`).toContain(`write('${id}'`);
      expect(src, `${id} must exist in the markup for the refresh to write into`).toContain(`id="${id}"`);
    }
  });

  it('the orders endpoint returns both sub-tab totals, not just the filtered one', () => {
    // `total` counts the CURRENT filter, so without this a client refreshing the active list could
    // never learn that history had grown.
    const src = read('src/pages/api/buyer/orders.ts');
    expect(src).toContain('countBuyerPurchases(allPurchases)');
  });
});

/**
 * The active/history split has ONE definition, and this scans the tree for a second.
 *
 * It began with two — the page computed the counts for the first paint and the API computed them
 * again for every refresh — which is a rule in two modules, and this repo's own name for the next
 * bug. The symptom would have been particularly cruel here: the number changing as the buyer
 * switches tabs and back, which is the complaint that started this work.
 */
describe('one definition of "which purchases are active"', () => {
  const ROOT = process.cwd();

  it('nobody hand-rolls the awaiting filter outside buyer-purchases.ts', () => {
    const files = [
      'src/pages/buyer/dashboard.astro',
      'src/pages/api/buyer/orders.ts',
      'src/lib/buyer-orders-query.ts',
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, `${f} must ask countBuyerPurchases rather than counting p.awaiting itself`)
        .not.toMatch(/filter\(\s*\(?\s*p\s*\)?\s*=>\s*p\.awaiting\s*\)\s*\.length/);
    }
  });

  it('history is the remainder, so the two can never both miss or both claim a purchase', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/buyer-purchases.ts'), 'utf8');
    expect(src).toMatch(/history:\s*purchases\.length\s*-\s*active/);
  });
});
