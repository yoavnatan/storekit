import type { Order } from './orders.js';
import { decodeList } from './admin-nav.js';

// Server-side counterpart of the seller dashboard's Orders tab toolbar
// (src/pages/seller/dashboard.astro's inline script) — pagination means the
// toolbar can no longer just show/hide DOM cards already on the page, so
// search+sort+filter have to run here over the full order list before
// slicing to a page, the same way admin-orders-filter.ts already does for
// the admin dashboard's own Orders tab.
export type SellerOrderSortCol = 'date' | 'amount' | 'urgency';
export type SellerOrderSortDir = 'asc' | 'desc';

// Urgency grouping for the "לפי דחיפות" sort. Group 0 = the seller still owes a
// shipping action (pending/processing/ready) → these float to the very top and,
// within the group, sort OLDEST-FIRST so the most overdue (escalated red/amber
// by order-age.ts) sit above fresh new ones. Then shipped (out of the seller's
// hands), then delivered (done — only present if the user explicitly filtered
// them in), then cancelled. Mirrors the order-age escalation model.
const URGENCY_GROUP: Record<string, number> = {
  pending: 0, processing: 0, ready: 0, shipped: 1, delivered: 2, cancelled: 3,
};
export const ORDER_ACTIVE_STATUSES = ['pending', 'processing', 'ready', 'shipped'];

export interface SellerOrderQuery {
  q: string;
  sortCol: SellerOrderSortCol;
  sortDir: SellerOrderSortDir;
  shippingStatus: string[];
}

const VALID_SORT_COLS = new Set<string>(['date', 'amount', 'urgency']);

export function parseSellerOrderQuery(sp: URLSearchParams): SellerOrderQuery {
  const [rawCol, rawDir] = (sp.get('osort') ?? 'date:desc').split(':');
  const sortCol = (VALID_SORT_COLS.has(rawCol ?? '') ? rawCol : 'date') as SellerOrderSortCol;
  const sortDir: SellerOrderSortDir = rawDir === 'asc' ? 'asc' : 'desc';
  // No ?ostatus at all → the toolbar's own default ("active" preset,
  // matching what a fresh page load already showed pre-pagination). An
  // explicit empty value (?ostatus=) means "cleared" — show every status.
  const hasStatusParam = sp.has('ostatus');
  return {
    q: (sp.get('oq') ?? '').trim(),
    sortCol,
    sortDir,
    shippingStatus: hasStatusParam ? decodeList(sp.get('ostatus') ?? '') : ORDER_ACTIVE_STATUSES,
  };
}

function orderAmount(o: Order, storeSlug: string): number {
  const sub = o.storeSubtotals[storeSlug];
  return sub ? sub.subtotal + sub.shipping : 0;
}

function orderSearchHaystack(o: Order): string {
  return `${o.id} ${o.checkoutRef ?? ''} ${o.buyerName} ${o.buyerEmail} ${o.buyerPhone}`.toLowerCase();
}

// `orders` is already scoped to one store (getOrdersByStoreSlug) — amount
// and search only ever look at that store's own slice of a (possibly
// multi-store) order.
export function filterAndSortSellerOrders(orders: Order[], storeSlug: string, query: SellerOrderQuery): Order[] {
  const statusSet = query.shippingStatus.length ? new Set(query.shippingStatus) : null;
  const q = query.q.toLowerCase();

  const filtered = orders.filter((o) => {
    if (statusSet && !statusSet.has(o.shippingStatus)) return false;
    if (q && !orderSearchHaystack(o).includes(q)) return false;
    return true;
  });

  const dir = query.sortDir === 'asc' ? 1 : -1;
  return [...filtered].sort((a, b) => {
    let cmp: number;
    switch (query.sortCol) {
      case 'amount': cmp = orderAmount(a, storeSlug) - orderAmount(b, storeSlug); break;
      case 'urgency': {
        const ga = URGENCY_GROUP[a.shippingStatus] ?? 9;
        const gb = URGENCY_GROUP[b.shippingStatus] ?? 9;
        if (ga !== gb) { cmp = ga - gb; break; }
        // Same group: owe-action (group 0) → oldest first (most overdue on top);
        // every other group → newest first.
        const older = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
        cmp = ga === 0 ? older : -older;
        break;
      }
      default:       cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    }
    return cmp * dir;
  });
}
