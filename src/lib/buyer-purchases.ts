import type { Order } from './orders.js';
import { checkoutGroupKey } from './checkout-group.js';
import { SHIPPING_PIPELINE_ORDER, SHIPPING_STATUS_RULES, type ShippingStatus } from './order-status-rules.js';

/**
 * One purchase, as the buyer made it — the unit their order list is built from.
 *
 * **An order is an order even when it is split across stores (user, 2026-08-05).**
 * `/api/checkout` deliberately writes ONE `orders` row per store, so each seller
 * owns an isolated record they can fulfil, cancel and be paid for without
 * touching anyone else's. That is right for the seller and for the money, and it
 * is not being changed. It was simply leaking to the buyer: a two-store basket
 * paid for in one click came back as two separate cards with two ids and two
 * dates, and nothing on the screen said they were the same purchase.
 *
 * So the split stays in the database and stops at the screen. `checkoutRef` is
 * what the two rows already have in common (it is also the number printed on the
 * confirmation), so it is the grouping key, and each row becomes a SLICE inside
 * the card — with its own store, its own fulfilment status and its own tracking
 * number, because those genuinely are per-store facts.
 *
 * Nothing here re-derives money: a slice's own total is the number its store
 * charged, and a purchase total is those added up.
 */
export interface PurchaseSlice {
  storeSlug: string;
  storeName: string;
  order: Order;
  totalAgorot: number;
}

export interface BuyerPurchase {
  /** What the buyer sees as "the order number". */
  ref: string;
  /** The earliest slice's — one click happened at one time; a later `createdAt`
   *  on a sibling row is the loop in checkout.ts writing rows in sequence. */
  createdAt: string;
  totalAgorot: number;
  /** The headline status. When the slices disagree it is the LEAST advanced of
   *  them, because that is the one the buyer is still waiting on. */
  status: ShippingStatus;
  slices: PurchaseSlice[];
  /** Still open, i.e. this belongs in "פעילות" and not in "היסטוריה". True while
   *  ANY slice is: a delivered parcel from one store does not finish an order
   *  whose other half hasn't shipped. */
  awaiting: boolean;
}

/** Where a status sits in the fulfilment pipeline; cancelled is off it entirely
 *  and sorts last, so it can never be the headline while a live slice exists. */
function pipelineRank(status: ShippingStatus): number {
  const i = SHIPPING_PIPELINE_ORDER.indexOf(status);
  return i === -1 ? SHIPPING_PIPELINE_ORDER.length : i;
}

/**
 * Group a buyer's order rows into purchases, newest first.
 *
 * `orders` arrives newest-first (orders.ts#getOrdersByBuyer) and that order is
 * preserved: a purchase takes the position of its first-seen slice. A row with
 * no `checkoutRef` — nothing writes one today, but rows predate the field — is
 * its own purchase keyed by its id, which renders exactly as it did before.
 */
export function groupBuyerPurchases(orders: readonly Order[]): BuyerPurchase[] {
  const byKey = new Map<string, Order[]>();
  for (const o of orders) {
    // The rule moved to `checkout-group.ts` on 2026-08-07, when the admin Orders tab started
    // grouping by the same key and needed it in SQL as well as here. It is one rule with two
    // spellings now, and they live next to each other in that file for exactly that reason.
    const key = checkoutGroupKey(o);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(o);
    else byKey.set(key, [o]);
  }

  return [...byKey.values()].map((rows) => {
    // Oldest first, i.e. the order checkout.ts wrote them in — the buyer's own cart order. The
    // caller hands rows newest-first, which for the slices of ONE click is backwards.
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const slices: PurchaseSlice[] = rows.map((order) => ({
      // The slice's store, off the row's own items. Every item in a row shares
      // one store by construction (checkout.ts filters them per store), so the
      // first one answers for the row; `storeSubtotals` has the same single key
      // and is what the card reads for shipping and discount.
      storeSlug: order.items[0]?.storeSlug ?? '',
      storeName: order.items[0]?.storeName ?? '',
      order,
      totalAgorot: order.totalAgorot,
    }));

    const statuses = slices.map((s) => s.order.shippingStatus);
    // Cancelled slices are skipped while any live one remains: an order with one
    // store cancelled and the rest shipped is a shipped order with a refund in
    // it, not a cancelled order. Only when every slice is cancelled does the
    // purchase read as cancelled.
    const live = statuses.filter((s) => !SHIPPING_STATUS_RULES[s].terminal);
    const headline = (live.length ? live : statuses)
      .reduce((worst, s) => (pipelineRank(s) < pipelineRank(worst) ? s : worst));

    return {
      ref: rows[0]!.checkoutRef ?? rows[0]!.id.slice(0, 8).toUpperCase(),
      createdAt: rows.reduce((earliest, o) => (o.createdAt < earliest ? o.createdAt : earliest), rows[0]!.createdAt),
      totalAgorot: rows.reduce((sum, o) => sum + o.totalAgorot, 0),
      status: headline,
      slices,
      awaiting: statuses.some((s) => SHIPPING_STATUS_RULES[s].buyerAwaiting),
    };
  });
}

/**
 * How many purchases sit under each of the buyer's two sub-tabs.
 *
 * One function because the numbers are rendered by TWO paths that must agree: the dashboard builds
 * them server-side for the first paint, and `/api/buyer/orders` returns them again on every
 * refresh. Computed separately — which is how this started — the two would drift the moment
 * "active" changed meaning, and the symptom would be the count on screen changing when the buyer
 * switches tabs and back. That is the exact complaint this whole area came from (owner,
 * 2026-08-11), so leaving a second definition in place would have been rebuilding it.
 *
 * `history` is the remainder rather than its own predicate, so the two can never both miss a
 * purchase or both claim one.
 */
export function countBuyerPurchases(purchases: readonly BuyerPurchase[]): { active: number; history: number } {
  const active = purchases.filter((p) => p.awaiting).length;
  return { active, history: purchases.length - active };
}
