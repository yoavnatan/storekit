import { getStoresBySellerId } from './stores.js';
import { getOrdersByStoreSlug } from './orders.js';
import { getMessagesBySeller, getMessageReplies } from './messages.js';

export async function getSellerStoreAlerts(sellerId: string): Promise<Record<string, boolean>> {
  const stores = await getStoresBySellerId(sellerId);
  const msgs = getMessagesBySeller(sellerId);
  const alerts: Record<string, boolean> = {};
  for (const s of stores) {
    const hasPending = getOrdersByStoreSlug(s.slug).some((o) => o.shippingStatus === 'pending');
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
