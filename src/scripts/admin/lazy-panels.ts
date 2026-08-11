import { buildAdminUrl, swapPanel, stripForeignTabParams } from '../../lib/admin-nav.js';
import { isPanelStale, markPanelFresh, panelHoldsTypedText } from '../../lib/panel-freshness.js';
import { initAdminSellersPanel } from './sellers.js';
import { initAdminStoresPanel } from './stores.js';
import { initAdminOrdersFilter } from './orders-filter.js';
import { initAdminMessagesPanel } from './admin-messages.js';
import { initAdminAlertsPanel } from './alerts.js';
import { initAdminAdvertisingPanel } from './advertising-platform.js';
import { initAdminPlatformPerformance } from './platform-performance.js';
import { initAdminDataPanel } from './data-panel.js';
import { initAdminMoneyLogPanel } from './moneylog.js';
import { initAdminPayoutsPanel } from './payouts.js';
import { initAdminStatementPanel } from './statement.js';
import { initPerformanceTab } from '../dashboard/performance.js';

/**
 * Fills an admin tab when it is opened — the first time, and again once its content has gone stale.
 *
 * The page renders ONE panel's data per request (`?panel=X`) — it used to build all eleven and let
 * `swapPanel` throw ten away, which is 41 queries and 522KB of HTML for one tab's worth of answer.
 * The other ten arrive here, on the click, through the exact mechanism every filter and pager on
 * this dashboard already uses: fetch `/admin?panel=X`, take that panel out of the response, and
 * re-run its wiring.
 *
 * **On a FIRST open the URL carries no params.** A panel being opened for the first time has no
 * filter state of its own — anything in the address bar belongs to the tab being LEFT, and
 * `stripForeignTabParams` (tab-nav.ts) is about to remove it anyway. A deep link like
 * `?panel=orders&oq=דני` is a different case entirely: that panel is the one the server already
 * rendered, so it is never lazy. **On a re-open it carries the panel's own params**, for the
 * mirror-image reason — by then the tab has filter state, and dropping it would look like the
 * dashboard forgetting what the admin had asked for.
 *
 * `data-lazy` is removed BEFORE the fetch starts, so a double click cannot start two loads. The
 * re-open path needs its own version of that (`inFlight`) and cannot borrow the freshness stamp
 * for it: the stamp is written when the swap LANDS, deliberately, so that a failed load stays
 * stale and gets retried — which leaves a full second during which the panel is still "stale" and
 * a second visit would start a duplicate fetch racing the first. If the load fails, `swapPanel`
 * falls back to a real navigation, which is the one thing guaranteed to produce a filled panel.
 */
const INIT: Record<string, () => void> = {
  sellers: initAdminSellersPanel,
  stores: initAdminStoresPanel,
  orders: initAdminOrdersFilter,
  messages: initAdminMessagesPanel,
  alerts: initAdminAlertsPanel,
  advertising: initAdminAdvertisingPanel,
  data: initAdminDataPanel,
  payouts: initAdminPayoutsPanel,
  statement: initAdminStatementPanel,
  moneylog: initAdminMoneyLogPanel,
  performance: () => { initPerformanceTab(); initAdminPlatformPerformance(); },
};

/** `panel` comes from a DOM id, and a plain object literal answers "constructor"/"toString" off its
 *  prototype — calling one of those would throw where an unknown panel should simply load and wire
 *  nothing. Hence `Object.hasOwn` rather than a bare lookup. */
/** Panels with a staleness refresh already on the wire — see the `inFlight` note in the block above. */
const inFlight = new Set<string>();

function reinitFor(panel: string): () => void {
  return Object.hasOwn(INIT, panel) ? INIT[panel]! : () => { /* nothing to wire */ };
}

export function initLazyAdminPanels(): void {
  // The panel the server rendered into this response is current as of right now. Left unstamped it
  // would read as never-loaded, and the admin's first click back onto it would re-fetch content
  // that is seconds old.
  document.querySelectorAll('[id^="dash-panel-"]:not([data-lazy])').forEach((el) => markPanelFresh(el.id));

  document.addEventListener('dashtab:show', (e) => {
    const el = e.target as HTMLElement | null;
    if (!el?.id.startsWith('dash-panel-')) return;
    const panel = el.id.slice('dash-panel-'.length);

    if (el.hasAttribute('data-lazy')) {
      // `data-lazy` is removed BEFORE the fetch starts, so a double click cannot start two loads.
      el.removeAttribute('data-lazy');
      void swapPanel(buildAdminUrl(panel, {}), el.id, reinitFor(panel));
      return;
    }

    // Already filled — so this is a RE-open, and the question is only whether what it holds is
    // still true (owner, 2026-08-11: opening a tab should show current data). Same swap, one
    // difference that matters: the URL keeps this panel's own filter and page, because re-opening
    // a tab you had filtered must not silently reset it to the unfiltered first page. That is
    // exactly why the lazy branch above passes no params and this one does — a first open has no
    // state of its own to preserve, and anything in the address bar there belongs to the tab
    // being left.
    if (inFlight.has(el.id) || panelHoldsTypedText(el) || !isPanelStale(el.id)) return;
    const url = stripForeignTabParams(new URL(location.href), panel);
    url.searchParams.set('panel', panel);
    inFlight.add(el.id);
    void swapPanel(`${url.pathname}${url.search}`, el.id, reinitFor(panel)).finally(() => inFlight.delete(el.id));
  });
}
