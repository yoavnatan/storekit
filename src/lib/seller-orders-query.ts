import type { Order } from './orders.js';
import { decodeList } from './admin-nav.js';

// Server-side counterpart of the seller dashboard's Orders tab toolbar
// (src/pages/seller/dashboard.astro's inline script) — pagination means the
// toolbar can no longer just show/hide DOM cards already on the page, so
// search+sort+filter have to run here over the full order list before
// slicing to a page, the same way admin-orders-filter.ts already does for
// the admin dashboard's own Orders tab.
export type SellerOrderSortCol = 'date' | 'amount' | 'status';
export type SellerOrderSortDir = 'asc' | 'desc';

const STATUS_RANK: Record<string, number> = { pending: 0, processing: 1, ready: 2, shipped: 3, delivered: 4 };
export const ORDER_ACTIVE_STATUSES = ['pending', 'processing', 'ready', 'shipped'];

export interface SellerOrderQuery {
  q: string;
  sortCol: SellerOrderSortCol;
  sortDir: SellerOrderSortDir;
  shippingStatus: string[];
}

const VALID_SORT_COLS = new Set<string>(['date', 'amount', 'status']);

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
      case 'status': cmp = (STATUS_RANK[a.shippingStatus] ?? 99) - (STATUS_RANK[b.shippingStatus] ?? 99); break;
      default:       cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    }
    return cmp * dir;
  });
}
