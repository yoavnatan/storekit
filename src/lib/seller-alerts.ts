import { getStoresBySellerId } from './stores.js';
import { getStoreSlugsWithPendingOrders } from './orders.js';
import { getStoreIdsWithUnreadMessages } from './messages.js';

/**
 * The red dot beside each store in the seller's store switcher: does this shop need attention?
 *
 * **Three queries, whatever the number of stores.** This runs in `Header.astro`, which means on
 * EVERY page a signed-in seller loads, so its cost is the cost of the site. It used to read the
 * whole order file per store and then the replies of every message thread one at a time — a shape a
 * filesystem cache absorbed and a connection pool of ten does not (DB_MIGRATION_PLAN.md §8, the N+1
 * note). Both loops are now single multi-store statements.
 *
 * The unread rule itself lives in `messages.ts`, beside the seller's inbox, rather than here: a
 * buyer's follow-up inside an already-opened thread is new mail, and two places deciding that is
 * how the dot and the inbox come to disagree.
 */
export async function getSellerStoreAlerts(sellerId: string): Promise<Record<string, boolean>> {
  const stores = await getStoresBySellerId(sellerId);
  if (stores.length === 0) return {};
  const [pendingSlugs, unreadStoreIds] = await Promise.all([
    getStoreSlugsWithPendingOrders(stores.map((s) => s.slug)),
    getStoreIdsWithUnreadMessages(sellerId, stores.map((s) => s.id)),
  ]);
  const alerts: Record<string, boolean> = {};
  for (const s of stores) {
    alerts[s.id] = pendingSlugs.has(s.slug) || unreadStoreIds.has(s.id);
  }
  return alerts;
}

export async function sellerHasAnyAlert(sellerId: string): Promise<boolean> {
  return Object.values(await getSellerStoreAlerts(sellerId)).some(Boolean);
}
