/**
 * "There's a marked tab that way" — a coloured beacon on the tab strip's edge.
 *
 * A `.dash-tabs` strip scrolls horizontally when it overflows (always, on a
 * phone), and several tabs carry a marker: the seller's orange low-stock count,
 * their red new-orders count and unread-messages dot, the admin's "(N) new"
 * counts. Scrolled out of the strip, every one of those was invisible — the
 * seller had no way to know a tab off to the side wanted them, and no reason to
 * scroll and find out (owner, 2026-08-05). The edge fade said "there is more
 * this way"; it could not say "and something over there needs you".
 *
 * So the fade grows a dot in the marker's own colour. The rule it follows:
 *
 *   the beacon shows a marker that EXISTS, is not `hidden`, and whose own box
 *   is not fully inside the strip's box — i.e. exactly the markers the eye
 *   cannot reach without scrolling. Scroll it into view and the beacon clears.
 *
 * Two things are deliberate here:
 *
 * 1. **The marker declares its own severity** (`data-tab-alert="danger"` /
 *    `"warning"`), rather than this module knowing which tab means what. There
 *    are five marker sites across two dashboards and three modules; a lookup
 *    table here would be a sixth copy of a rule that drifts the moment a tab is
 *    added. `danger` = someone is waiting / something broke (the site already
 *    paints every "new/unread" mark red). `warning` = a state that is merely
 *    wrong and can wait — today only low stock. Highest severity present that
 *    way wins the colour, so a red marker is never masked by an orange one.
 *
 * 2. **A MutationObserver, not a callback every writer must remember.** The
 *    counts are live: orders.ts rebuilds its badge, products.ts flips the stock
 *    badge's `hidden`, messages.ts polls, admin's tab-nav clears a count on
 *    leaving a tab. Handing each of them a "and now re-sync the beacon" call is
 *    the shape that rots — the sixth writer forgets. Observing the strip covers
 *    every writer that exists and every one that doesn't yet, for a subtree of
 *    ~10 nodes. It watches only `childList` + the two attributes a marker can
 *    change (`hidden`, `data-tab-alert`); the sync writes `data-alert-start` /
 *    `data-alert-end` on the STRIP, none of which are observed, so it cannot
 *    re-trigger itself.
 *
 * Painting lives in dashboard.css (`.dash-tab-fade::after`), on the fade, so
 * the beacon inherits the fade's own opacity — it can only ever be visible when
 * there genuinely is strip left to scroll that way.
 */

/** Highest wins. Absent = no marker that way. */
const RANK = { warning: 1, danger: 2 } as const;
type Severity = keyof typeof RANK;

function severityOf(el: Element): Severity | null {
  const v = el.getAttribute('data-tab-alert');
  return v === 'danger' || v === 'warning' ? v : null;
}

/**
 * Wire a strip and return its sync function. The caller runs it alongside the
 * strip's other edge bookkeeping (scroll / resize); mutations re-run it here.
 */
export function initTabAlertEdges(strip: HTMLElement): () => void {
  // `direction` maps the two VISUAL sides onto the two LOGICAL ones — the fades
  // are placed with `inset-inline-start/end`, so in Hebrew the "start" fade is
  // the one on the right (memory: RTL arrow keys, same trap). Read once, like
  // the wheel handler in ui.ts does: this runs on every scroll event, and the
  // page reloads on a language change anyway.
  const rtl = getComputedStyle(strip).direction === 'rtl';

  const sync = (): void => {
    let atStart: Severity | null = null;
    let atEnd: Severity | null = null;
    const worse = (a: Severity | null, b: Severity) => (a && RANK[a] >= RANK[b] ? a : b);

    // A strip that fits hides nothing, so there is nothing to point at — and
    // this runs on every scroll event, so it is worth not measuring every
    // marker on a desktop-width strip. It must still fall through to the write
    // below: a strip that STOPS overflowing (a resize, a tab removed) would
    // otherwise keep a beacon pointing at a marker now in plain sight.
    if (strip.scrollWidth > strip.clientWidth + 1) {
      const s = strip.getBoundingClientRect();
      // Scoped to the strip, not to `[role="tab"] *` — a marker may equally be
      // an attribute on the tab button itself, and a beacon that silently
      // ignored half the ways of declaring one is worse than no beacon.
      strip.querySelectorAll<HTMLElement>('[data-tab-alert]').forEach((marker) => {
        const sev = severityOf(marker);
        if (!sev || marker.hidden) return;
        const m = marker.getBoundingClientRect();
        // A marker only partly out is still a marker you can't read. The 1px
        // slack matches syncEdges()'s — sub-pixel strip widths are routine.
        if (m.left < s.left - 1) { if (rtl) atEnd = worse(atEnd, sev); else atStart = worse(atStart, sev); }
        if (m.right > s.right + 1) { if (rtl) atStart = worse(atStart, sev); else atEnd = worse(atEnd, sev); }
      });
    }

    // Both values come from the closed set above, never from the attribute's
    // raw text — an unknown severity is dropped by severityOf rather than
    // reaching a CSS selector.
    if (atStart) strip.dataset.alertStart = atStart; else delete strip.dataset.alertStart;
    if (atEnd) strip.dataset.alertEnd = atEnd; else delete strip.dataset.alertEnd;
  };

  if ('MutationObserver' in window) {
    new MutationObserver(sync).observe(strip, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['hidden', 'data-tab-alert'],
    });
  }
  return sync;
}
