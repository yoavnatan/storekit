import { wirePanelLinks, wirePopstateReload } from '../../lib/admin-nav.js';

// The money journal's tab is read-only — no search box, no toolbar, nothing to
// re-bind per row — so its only client-side need is the one every other admin list
// tab has: its own links (the type-filter chips and the pager) should swap the
// panel in place instead of reloading the whole dashboard. Hence no reinit
// callback: the swapped HTML is inert, and wirePanelLinks binds to the panel
// container, which survives every swap.
const PANEL_ID = 'dash-panel-moneylog';

export function initAdminMoneyLogPanel(): void {
  wirePanelLinks(PANEL_ID, () => {});
  wirePopstateReload();
}
