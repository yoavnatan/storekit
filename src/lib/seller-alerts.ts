import { getStoresBySellerId } from './stores.js';
import { getStoreSlugsWithPendingOrders } from './orders.js';
import { getStoreIdsWithUnreadMessages } from './messages.js';
import { getStoreIdsWithStockAlerts } from './store-products.js';
import { getStoreIdsWithStalledCampaigns } from './ad-campaigns.js';
import { LOW_STOCK_THRESHOLD } from './variant-combo.js';

/**
 * Everything about this seller that is waiting on them — the one source for every red dot.
 *
 * **The dots form a CHAIN, and the chain is the feature** (owner, סשן א׳ §5). A dot on the avatar
 * has to lead to a dot in the account dropdown, which leads to a dot on a store or a tab, which
 * leads to the field or the row that needs doing. A dot with no dot under it is a dead end, and a
 * thing that needs doing with no dot above it is invisible until the seller happens to look. So a
 * new "requires attention" state is added HERE and every surface reads it, rather than each surface
 * deciding for itself what counts.
 *
 * All of them are PER STORE — a pending order, unread mail, stock that ran out, a boost the
 * platform stopped. Each belongs to one shop, so it dots that shop's row in the switcher and its
 * own tab inside that shop's dashboard.
 *
 * There was one account-wide alert until 2026-08-21: money released with no bank account to send it
 * to. It cannot occur any more — the processor pays each seller directly, so the platform never
 * holds money that could be released — and it took the whole `needsBank` half of this module with
 * it, including the reason the header had to ask an account-wide question at all.
 *
 * ── The two SEVERITIES, and why the switcher needs both (owner, 2026-08-12) ──
 * The per-store dot used to mean orders-or-mail and nothing else, so a seller switching shops was
 * told about the two things a *buyer* was waiting on and about none of the things the *shop* was
 * waiting on. Both are now here, separated exactly the way the dashboard's own tab strip already
 * separates them (`data-tab-alert`, scripts/dashboard/tab-alert-edges.ts):
 *   • `danger`  — a person is waiting: a pending order, unread mail.
 *   • `warning` — a wrong state that can wait: products out of / low on stock, a boost paused for
 *     a reason that will not undo itself.
 * A store showing both takes the higher one, because a dot is one pixel and cannot say two things.
 *
 * **`warning` deliberately stops at the switcher and never reaches the avatar.** The header dot
 * says "something is waiting on you" on every page of the site; low stock is a state a working
 * shop is in most of the time, so promoting it there would leave that dot permanently lit and
 * teach the seller to stop seeing it — which costs the orders it exists to announce. Anything a
 * person waits on still travels the whole chain.
 *
 * ── Cost, which is the cost of the SITE ──
 * `sellerHasAnyAlert` runs in `Header.astro`, i.e. on every page a signed-in seller loads, and it
 * asks the DANGER half only: three multi-store statements whatever the number of stores
 * (AI_INSTRUCTIONS → Scalability), plus one primary-key read for the seller row — unchanged by the
 * two states added above, which are read by the dashboard alone.
 *
 * The unread rule itself lives in `messages.ts`, beside the seller's inbox, rather than here: a
 * buyer's follow-up inside an already-opened thread is new mail, and two places deciding that is
 * how the dot and the inbox come to disagree. Same for the two new ones — the stock threshold is
 * `variant-combo.ts#LOW_STOCK_THRESHOLD` and the badge's own query, and which pause reasons need a
 * human is `ad-campaign-health.ts`'s answer, read through `getStoreIdsWithStalledCampaigns`.
 */
export type StoreAlertLevel = 'danger' | 'warning';

export interface SellerAlerts {
  /** storeId → this shop has something waiting, and how loudly. Absent = nothing. */
  byStore: Record<string, StoreAlertLevel>;
}

/** The danger half alone — everything a PERSON is waiting on. What the header asks. */
export async function getSellerAlerts(sellerId: string): Promise<SellerAlerts> {
  return collect(sellerId, false);
}

/** The per-store map alone, danger AND warning — what the store switcher's rows render. */
export async function getSellerStoreAlerts(
  sellerId: string,
): Promise<Record<string, StoreAlertLevel>> {
  return (await collect(sellerId, true)).byStore;
}

/** Anything a person is waiting on, of either kind. The avatar dot and the "seller dashboard" link
 *  in the header dropdown, which are the top of the chain and therefore have to include the
 *  account-wide states as well as the per-store ones — but not the warnings (see the header). */
export async function sellerHasAnyAlert(sellerId: string): Promise<boolean> {
  const alerts = await getSellerAlerts(sellerId);
  return Object.keys(alerts.byStore).length > 0;
}

async function collect(sellerId: string, withWarnings: boolean): Promise<SellerAlerts> {
  const stores = await getStoresBySellerId(sellerId);
  // No store means no orders and no mail — there is nothing this seller can be behind on yet.
  if (stores.length === 0) return { byStore: {} };

  const ids = stores.map((s) => s.id);
  const [pendingSlugs, unreadStoreIds, lowStockIds, stalledAdIds] = await Promise.all([
    getStoreSlugsWithPendingOrders(stores.map((s) => s.slug)),
    getStoreIdsWithUnreadMessages(sellerId, ids),
    withWarnings ? getStoreIdsWithStockAlerts(ids, LOW_STOCK_THRESHOLD) : new Set<string>(),
    withWarnings ? getStoreIdsWithStalledCampaigns(ids) : new Set<string>(),
  ]);
  const byStore: Record<string, StoreAlertLevel> = {};
  for (const s of stores) {
    // Danger wins outright — a store with both an unread buyer and a low shelf is a store someone
    // is waiting on, and the dot has one colour to spend.
    if (pendingSlugs.has(s.slug) || unreadStoreIds.has(s.id)) byStore[s.id] = 'danger';
    else if (lowStockIds.has(s.id) || stalledAdIds.has(s.id)) byStore[s.id] = 'warning';
  }
  return { byStore };
}
