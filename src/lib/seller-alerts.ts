import { getStoresBySellerId } from './stores.js';
import { getStoreSlugsWithPendingOrders } from './orders.js';
import { getMessagesBySeller, getMessageReplies } from './messages.js';

export async function getSellerStoreAlerts(sellerId: string): Promise<Record<string, boolean>> {
  const stores = await getStoresBySellerId(sellerId);
  const msgs = getMessagesBySeller(sellerId);
  // ONE query for every store, not one per store. This runs on the seller's dashboard header —
  // the loop below used to read the whole order file per store, which a filesystem cache absorbed
  // and a connection pool of ten does not (DB_MIGRATION_PLAN.md §8, the N+1 note).
  const pendingSlugs = await getStoreSlugsWithPendingOrders(stores.map((s) => s.slug));
  const alerts: Record<string, boolean> = {};
  for (const s of stores) {
    const hasPending = pendingSlugs.has(s.slug);
    // Replies carry no toStoreId (only the root message does), so a buyer
    // follow-up in an already-read thread wouldn't show up on its own —
    // check each thread's replies too, same definition used by the seller
    // messages table and the /api/messages?unread=1 endpoint.
    const hasUnread = msgs
      .filter((m) => !m.replyToId && m.toStoreId === s.id)
      .some((m) => !m.readBySeller || getMessageReplies(m.id).some((r) => r.toSellerId === sellerId && !r.readBySeller));
    alerts[s.id] = hasPending || hasUnread;
  }
  return alerts;
}

export async function sellerHasAnyAlert(sellerId: string): Promise<boolean> {
  return Object.values(await getSellerStoreAlerts(sellerId)).some(Boolean);
}
