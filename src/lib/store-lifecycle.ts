/** Pausing, closing and reopening a store — the only writer of the lifecycle flags on the store
 *  record (stores.ts). What each resulting state MEANS is the table in store-status.ts; this file
 *  is about the transitions and their consequences.
 *
 *  The problem it solves, in the seller's words: there are orders that have not been delivered,
 *  and meanwhile nothing more should be sold. Those are two different needs, and conflating them
 *  is what makes marketplaces either strand buyers or trap sellers:
 *
 *    "stop selling now"   → pauseStore. Immediate, unconditional, one click back. The storefront
 *                           stays up and says it is on hold, the dashboard keeps working, and the
 *                           seller finishes the orders they already owe.
 *    "I am leaving"       → requestStoreClosure. If nothing is owed, it closes on the spot. If
 *                           orders are still open it does NOT refuse — it pauses the store (so no
 *                           new order can arrive) and leaves the closure PENDING; settleStoreClosure
 *                           finishes it by itself when the last open order is done. Refusing would
 *                           mean the seller has to come back and press the button again, which is
 *                           a manual step in a platform that promises none.
 *
 *  Nothing here deletes. A closed store's record, products, orders, money events and ad spend all
 *  stay exactly where they were, because every historical platform total is derived from them and
 *  a figure that changes retroactively is worse than one that includes a store that has left.
 *
 *  Ads follow automatically rather than being switched off here one by one: a store that cannot
 *  sell has no reachable products (ad-campaign-health.ts#reachableProducts), which starves every
 *  boost campaign and pauses it through the path that already exists — metrics frozen, spend
 *  stopped, nothing erased. Only the FINAL closure archives them, because at that point there is
 *  nothing left to resume into.
 */
import { getStoreById, getStoreBySlug, updateStore, type Store } from './stores.js';
import { storeLifecycle, type StoreLifecycle } from './store-status.js';
import { countOrdersByStoreSlug, type Order } from './orders.js';
import {
  orderBlocksStoreClosure,
  CLOSURE_BLOCKING_PAYMENT_STATUSES,
  CLOSURE_BLOCKING_SHIPPING_STATUSES,
} from './order-status-rules.js';
import { archiveCampaignsForStore } from './ad-campaigns.js';

/** Orders this store still owes something on — the ones that hold a closure open. Paid-and-
 *  undelivered and awaiting-payment both count; cancelled, delivered and failed do not. The rule
 *  itself is a column in order-status-rules.ts so a new order status has to answer the question. */
export async function openOrderCount(storeSlug: string): Promise<number> {
  // A COUNT, not a filtered fetch. The predicate below is the same table's two columns handed to
  // the query as lists (orders.ts#countOrdersByStoreSlug), so the answer cannot drift from
  // `orderBlocksStoreClosure` beside it — which matters here more than anywhere: this number is
  // the gate on a store being allowed to close, and a store that closes while an order is open is
  // a buyer whose parcel nobody owns.
  return countOrdersByStoreSlug(storeSlug, CLOSURE_BLOCKING_PAYMENT_STATUSES, CLOSURE_BLOCKING_SHIPPING_STATUSES);
}

/** The same count for a caller that has ALREADY read the orders — the admin dashboard reads every
 *  order once and then wants this per store, and calling openOrderCount per row would re-read and
 *  re-filter the whole file once per store. Pure, and it is the same predicate, so the admin's
 *  "3 open" can never disagree with the seller's own screen. */
export function countOpenOrdersByStore(orders: Order[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const order of orders) {
    if (!orderBlocksStoreClosure(order)) continue;
    // An order can name more than one store only in the multi-store cart; each store counts it
    // once, and a store named twice in one order is still one obligation.
    for (const slug of new Set(order.items.map((i) => i.storeSlug))) {
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  return counts;
}

export type LifecycleChange =
  | { ok: true; store: Store; state: StoreLifecycle; openOrders: number }
  | { ok: false; error: string };

/** Blocked is the admin's, not the seller's — a seller must never be able to pause-and-reopen
 *  their way out of a block, and a completed closure has no transitions left at all. */
function refuseIfNotSellerControlled(store: Store): string | null {
  const state = storeLifecycle(store);
  if (state === 'blocked') return 'החנות חסומה על ידי הצוות ולא ניתן לשנות את מצבה.';
  if (state === 'closed') return 'החנות סגורה.';
  return null;
}

/** Stop selling, keep the storefront up. Idempotent: pausing an already-paused (or closing)
 *  store changes nothing rather than re-stamping the timestamp, so a second dashboard tab
 *  can't move the moment the pause began. */
export async function pauseStore(storeId: string): Promise<LifecycleChange> {
  const store = await getStoreById(storeId);
  if (!store) return { ok: false, error: 'החנות לא נמצאה.' };
  const refusal = refuseIfNotSellerControlled(store);
  if (refusal) return { ok: false, error: refusal };
  const updated = store.pausedAt ? store : await updateStore(storeId, { pausedAt: new Date().toISOString() });
  if (!updated) return { ok: false, error: 'החנות לא נמצאה.' };
  return { ok: true, store: updated, state: storeLifecycle(updated), openOrders: await openOrderCount(updated.slug) };
}

/** Back to selling. Also the "cancel the closure" action — a pending closure is just a pause
 *  with an intent attached, so undoing it clears both flags and there is no second button to
 *  build or to get out of step with this one. */
export async function resumeStore(storeId: string): Promise<LifecycleChange> {
  const store = await getStoreById(storeId);
  if (!store) return { ok: false, error: 'החנות לא נמצאה.' };
  const refusal = refuseIfNotSellerControlled(store);
  if (refusal) return { ok: false, error: refusal };
  const updated = await updateStore(storeId, { pausedAt: undefined, closePendingAt: undefined });
  if (!updated) return { ok: false, error: 'החנות לא נמצאה.' };
  return { ok: true, store: updated, state: storeLifecycle(updated), openOrders: await openOrderCount(updated.slug) };
}

/** The final step, shared by the immediate close and the deferred one. Archives every live boost
 *  campaign on the way out: archiveCampaign stops it, freezes its metrics at this instant and
 *  keeps the row (money it already spent is a fact — ad-campaigns.ts#archivedAt). */
async function finalizeClosure(store: Store): Promise<Store | null> {
  // One statement, not one per campaign: closure always archives ALL of them, so the loop this
  // replaces was a write per campaign every single time rather than in a rare case.
  await archiveCampaignsForStore(store.id);
  return updateStore(store.id, {
    closedAt: new Date().toISOString(),
    closePendingAt: undefined,
    pausedAt: undefined,
  });
}

/** Close the store — now if nothing is owed, otherwise as soon as everything is.
 *  Either way the store stops selling immediately, which is the half the seller asked for. */
export async function requestStoreClosure(storeId: string): Promise<LifecycleChange> {
  const store = await getStoreById(storeId);
  if (!store) return { ok: false, error: 'החנות לא נמצאה.' };
  const refusal = refuseIfNotSellerControlled(store);
  if (refusal) return { ok: false, error: refusal };

  const openOrders = await openOrderCount(store.slug);
  const updated = openOrders === 0
    ? await finalizeClosure(store)
    // pausedAt as well as closePendingAt: `closing` already implies "not selling" in the status
    // table, but carrying the pause explicitly means cancelling the closure has one obvious
    // meaning (clear both, back to active) rather than depending on which flag was set first.
    : await updateStore(storeId, {
        closePendingAt: store.closePendingAt ?? new Date().toISOString(),
        pausedAt: store.pausedAt ?? new Date().toISOString(),
      });
  if (!updated) return { ok: false, error: 'החנות לא נמצאה.' };
  return { ok: true, store: updated, state: storeLifecycle(updated), openOrders };
}

/** Finish a pending closure once the store owes nothing. Called wherever an order can reach a
 *  status that stops blocking (the seller orders API) — deliberately event-driven rather than a
 *  sweep on read: the storefront must not do an orders file-read on every page view, and the set
 *  of events that can free a closure is exactly "an order changed status".
 *
 *  Safe to call for any store, in any state, at any time: it is a no-op unless a closure is
 *  actually pending and actually unblocked. Returns the store only when it just closed.
 *
 *  **The second trigger does not exist yet, and its absence is correct only for now.**
 *  `orderBlocksStoreClosure` reads BOTH `paymentStatus` and `shippingStatus`, but the only caller
 *  today is the shipping-status branch of `/api/seller/orders` — which is complete, because
 *  nothing writes `paymentStatus` after checkout (orders.ts stamps 'paid' at creation as a
 *  documented stand-in). The moment `/api/payment/confirm` lands (CURRENT_TASK #2) a payment
 *  moving to 'failed' stops blocking a closure with nobody here to notice, and the store sits in
 *  `closing` until some unrelated order happens to change shipping status. That webhook must call
 *  this — logged with its trigger in GO_LIVE_CHECKLIST.md §3. */
export async function settleStoreClosure(storeSlug: string): Promise<Store | null> {
  const store = await getStoreBySlug(storeSlug);
  if (!store || storeLifecycle(store) !== 'closing') return null;
  if (await openOrderCount(store.slug) > 0) return null;
  return finalizeClosure(store);
}
