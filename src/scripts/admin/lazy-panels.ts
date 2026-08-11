import { buildAdminUrl, swapPanel } from '../../lib/admin-nav.js';
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
import { initPerformanceTab } from '../dashboard/performance.js';

/**
 * Fills an admin tab the first time it is opened.
 *
 * The page renders ONE panel's data per request (`?panel=X`) — it used to build all eleven and let
 * `swapPanel` throw ten away, which is 41 queries and 522KB of HTML for one tab's worth of answer.
 * The other ten arrive here, on the click, through the exact mechanism every filter and pager on
 * this dashboard already uses: fetch `/admin?panel=X`, take that panel out of the response, and
 * re-run its wiring.
 *
 * **The URL carries no params.** A panel being opened for the first time has no filter state of its
 * own — anything in the address bar belongs to the tab being LEFT, and `stripForeignTabParams`
 * (tab-nav.ts) is about to remove it anyway. A deep link like `?panel=orders&oq=דני` is a different
 * case entirely: that panel is the one the server already rendered, so it is never lazy.
 *
 * `data-lazy` is removed BEFORE the fetch starts, so a double click cannot start two loads. If the
 * load fails, `swapPanel` falls back to a real navigation, which is the one thing guaranteed to
 * produce a filled panel.
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
  moneylog: initAdminMoneyLogPanel,
  performance: () => { initPerformanceTab(); initAdminPlatformPerformance(); },
};

export function initLazyAdminPanels(): void {
  document.addEventListener('dashtab:show', (e) => {
    const el = e.target as HTMLElement | null;
    if (!el?.id.startsWith('dash-panel-') || !el.hasAttribute('data-lazy')) return;
    el.removeAttribute('data-lazy');
    const panel = el.id.slice('dash-panel-'.length);
    // `Object.hasOwn`, not a bare lookup: `panel` comes from a DOM id, and a plain object literal
    // answers "constructor"/"toString" off its prototype — calling one of those would throw where
    // an unknown panel should simply load and wire nothing.
    const reinit = Object.hasOwn(INIT, panel) ? INIT[panel]! : () => { /* nothing to wire */ };
    void swapPanel(buildAdminUrl(panel, {}), el.id, reinit);
  });
}
