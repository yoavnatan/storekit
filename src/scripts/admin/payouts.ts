import { wirePanelLinks } from '../../lib/admin-nav.js';

/**
 * The admin "תשלומים למוכרים" tab — one pager, and that is the whole of its behaviour.
 *
 * It exists because without it the pager is a plain link and turning a page RELOADS the admin
 * dashboard: every panel re-rendered and every script re-parsed, to move one table by fifteen rows.
 * The owner objected to exactly that on the seller's copy of this screen (2026-08-10), and it was
 * true here too. `wirePanelLinks` is the mechanism every other admin tab's pager already uses —
 * intercept a same-tab `/admin?` link, `swapPanel` the panel out of the response, re-run this.
 *
 * ⚠️ A correction worth recording, because the wrong version was written down first: this module
 * was going to be skipped on the grounds that a pager "goes through the delegated link handler
 * wired on the container itself", which is what `overview` and `attention` supposedly do. There is
 * no such shared handler. `wirePanelLinks` is called BY each panel's own module, so a panel without
 * a module has no interception at all and its pager navigates — which is what `attention`'s does
 * today. Registering here is what makes the claim true rather than assumed.
 *
 * `wirePanelLinks` guards itself with `data-linksWired` on the container, so being called again
 * after a swap re-binds nothing.
 */
const PANEL_ID = 'dash-panel-payouts';

export function initAdminPayoutsPanel(): void {
  wirePanelLinks(PANEL_ID, () => initAdminPayoutsPanel());
}
