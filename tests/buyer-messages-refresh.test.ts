import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Opening the buyer's messages tab re-renders the panel from the server, so a conversation a seller
 * started since page load actually appears (owner, 2026-08-11). The 15s poll could never do that —
 * it walks `[data-bmsg-id]` and updates rows that already exist.
 *
 * Everything here is a source scan, because the two ways this breaks are both invisible:
 *
 *  · **A listener bound twice.** Re-running an init that also binds to `document` adds a second
 *    copy on every refresh, and the second copy of the reply handler sends the message twice. The
 *    symptom is a duplicate message in a seller's inbox, days later, with nothing in the client to
 *    show for it.
 *  · **A captured element left dangling.** The swap replaces the panel's contents, so anything
 *    holding a reference from page load is pointing at a detached node afterwards. Sorting still
 *    "works" — it reorders rows inside a table that is no longer in the document.
 */

const ROOT = process.cwd();
const PAGE = path.join(ROOT, 'src/pages/buyer/dashboard.astro');
const read = () => fs.readFileSync(PAGE, 'utf8');

/** The body of `bindBuyerMessagesPanel`, which is the code that runs AGAIN on every refresh. */
function reboundBody(): string {
  const src = read();
  const start = src.indexOf('function bindBuyerMessagesPanel(): void {');
  expect(start, 'bindBuyerMessagesPanel disappeared — the refresh cannot re-wire the panel without it').toBeGreaterThan(-1);
  const end = src.indexOf('} // end bindBuyerMessagesPanel', start);
  expect(end, 'the end marker of bindBuyerMessagesPanel is gone').toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('the messages panel can be re-wired without binding anything twice', () => {
  it('nothing inside the re-run block binds to document or window', () => {
    // These survive every swap, so a listener on them is added once and must stay that way.
    const body = reboundBody();
    expect(body).not.toMatch(/document\.addEventListener/);
    expect(body).not.toMatch(/window\.addEventListener/);
  });

  it('the portal listeners that DO bind to document sit outside the re-run block', () => {
    // They are the reason the boundary is where it is; if they drifted inside, every refresh would
    // add another Escape handler and another outside-click closer.
    const src = read();
    const bindStart = src.indexOf('function bindBuyerMessagesPanel(): void {');
    const portalListeners = src.slice(0, bindStart);
    expect(portalListeners).toContain("document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBmsgPortal(); });");
  });

  it('the refresh clears the thread-loader map before re-binding', () => {
    // Loaders are keyed by thread id and close over rows the swap has just discarded. A stale one
    // left behind would be called by the unread poll and write into a detached node.
    const src = read();
    expect(src).toMatch(/buyerThreadLoaders\.clear\(\);[\s\S]{0,400}bindBuyerMessagesPanel\(\);/);
  });
});

describe('nothing survives the swap by reference', () => {
  it('the table body is looked up per use, never captured at load', () => {
    const src = read();
    expect(src).toContain("const bmsgTbodyEl = () => document.querySelector");
    // The old captured `const bmsgTbody = document.querySelector(...)` must not come back.
    expect(src).not.toMatch(/const bmsgTbody\s*=\s*document\.querySelector/);
  });

  it('the mixed-status flag and everything derived from it are recomputed', () => {
    // A refresh that brings in the buyer's first unread message flips this. Captured as a const, the
    // status column's sort and filter would stay hidden for the life of the page.
    const src = read();
    expect(src).toContain('const bmsgMixedStatus = () =>');
    expect(src).toContain('const bmsgFilterColumns = (): string[] =>');
    expect(src).toContain('const bmsgSortOptions = ()');
    expect(src, 'a captured SORT_OPTIONS array would freeze the status option out')
      .not.toMatch(/const BMSG_SORT_OPTIONS\s*:/);
  });
});

describe('the swap keeps what the buyer chose, and never what they typed', () => {
  it('restores sort, filters and expanded threads', () => {
    const src = read();
    const refresh = src.slice(src.indexOf('async function refreshBuyerMessages'));
    expect(refresh).toContain('sortBmsg(bmsgSortCol, bmsgSortDir)');
    expect(refresh).toContain('applyBmsgFilter()');
    expect(refresh).toContain('msg-table__row--open');
  });

  it('re-opens threads by an ESCAPED id', () => {
    // Thread ids reach a selector here. Unescaped, an id containing a selector character throws and
    // takes the whole refresh down with it.
    const refresh = read().slice(read().indexOf('async function refreshBuyerMessages'));
    expect(refresh).toContain('CSS.escape(id)');
  });

  it('is never reached with unsaved text in the panel', () => {
    // The guarantee the owner asked for: a half-written reply is worth more than a fresher list.
    // Asserted on the ORDER inside the dispatcher, so a comment growing between the two lines does
    // not fail it but moving the call above its guard does.
    const src = read();
    const body = src.slice(
      src.indexOf('function refreshBuyerPanel(key: string): void {'),
      src.indexOf('function activateBuyerTab'),
    );
    expect(body, 'refreshBuyerPanel moved or was renamed').toContain('panelHoldsTypedText(panel)');
    expect(body.indexOf('panelHoldsTypedText(panel)'))
      .toBeLessThan(body.indexOf('refreshBuyerMessages()'));
    expect(body.indexOf('panelHoldsTypedText(panel)'))
      .toBeLessThan(body.indexOf('applyBuyerOrdersPagination()'));
  });

  it('leaves the old conversations up when the fetch fails', () => {
    // Stale is not wrong. Blanking the tab would read as the buyer's conversations being deleted.
    const refresh = read().slice(read().indexOf('async function refreshBuyerMessages'));
    expect(refresh).toMatch(/if \(!res\.ok\) return;/);
    expect(refresh).toMatch(/if \(!next\) return;/);
  });

  it('cannot start two refreshes at once', () => {
    const refresh = read().slice(read().indexOf('async function refreshBuyerMessages'));
    expect(refresh).toContain('bmsgRefreshInFlight');
  });
});

/**
 * The one that would have made this whole feature a no-op, found in review rather than on screen.
 *
 * `pollBuyerUnread` runs every 15s and the staleness window is 30s. When the poll marked the panel
 * fresh, the panel was never stale, so the refresh on tab open could never fire — a new conversation
 * stayed invisible exactly as before, with all the code to fix it present and passing its tests.
 *
 * The rule that prevents it coming back is general: only something that can make the panel CURRENT
 * may stamp it fresh. A partial update must not, however recent it is.
 */
describe('only a full refresh may claim the messages panel is current', () => {
  it('the unread poll does not stamp the panel fresh', () => {
    const src = read();
    const poll = src.slice(
      src.indexOf('function pollBuyerUnread()'),
      src.indexOf('pollWhileVisible(pollBuyerUnread'),
    );
    expect(poll, 'pollBuyerUnread was not found where expected').not.toHaveLength(0);
    expect(poll, 'a partial update must not suppress the full refresh')
      .not.toContain("markPanelFresh('buyer:messages')");
  });

  it('the full refresh does stamp it', () => {
    const refresh = read().slice(read().indexOf('async function refreshBuyerMessages'));
    expect(refresh).toContain("markPanelFresh('buyer:messages')");
  });

  it('the poll interval is shorter than the staleness window it must not defeat', () => {
    // If these ever cross, the bug above returns silently: a poll slower than the window is
    // harmless, a poll faster than it is only harmless because it no longer stamps.
    // `pollWhileVisible` since 2026-08-21 (a buyer tab left open should not keep asking) — the
    // period is what this test is about and it is unchanged.
    const src = read();
    expect(src).toContain('pollWhileVisible(pollBuyerUnread, 15000)');
  });
});
