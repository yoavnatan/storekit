import type { Order } from './orders.js';
import { decodeList } from './admin-nav.js';

// Server-side counterpart of the admin Orders tab's search/sort/filter
// toolbar (src/scripts/admin/orders-filter.ts) — pagination meant the
// toolbar could no longer just show/hide DOM cards already on the page, so
// filtering+sorting had to move here and run over the full order list before
// slicing to a page, the same way product-listing.ts already does for the
// public store page.
export type AdminOrderSortCol = 'date' | 'amount' | 'shippingStatus';
export type AdminOrderSortDir = 'asc' | 'desc';

const SHIPPING_RANK: Record<string, number> = { pending: 0, processing: 1, ready: 2, shipped: 3, delivered: 4 };

export interface AdminOrderQuery {
  q?: string;
  sortCol?: AdminOrderSortCol;
  sortDir?: AdminOrderSortDir;
  shippingStatus?: string[];
  paymentStatus?: string[];
  store?: string[];
}

function orderStoreNames(o: Order): string[] {
  return [...new Set(o.items.map((i) => i.storeName))];
}

function orderSearchHaystack(o: Order, stores: string[]): string {
  return `${o.id} ${o.checkoutRef ?? ''} ${o.buyerName} ${o.buyerEmail} ${o.buyerPhone} ${stores.join(' ')}`.toLowerCase();
}

export function filterAndSortOrders(orders: Order[], query: AdminOrderQuery): Order[] {
  const q = query.q?.trim().toLowerCase() ?? '';
  const shipSet = query.shippingStatus?.length ? new Set(query.shippingStatus) : null;
  const paySet = query.paymentStatus?.length ? new Set(query.paymentStatus) : null;
  const storeSet = query.store?.length ? new Set(query.store) : null;

  const filtered = orders.filter((o) => {
    if (shipSet && !shipSet.has(o.shippingStatus)) return false;
    if (paySet && !paySet.has(o.paymentStatus)) return false;
    const stores = orderStoreNames(o);
    if (q && !orderSearchHaystack(o, stores).includes(q)) return false;
    if (storeSet && !stores.some((s) => storeSet.has(s))) return false;
    return true;
  });

  const col = query.sortCol ?? 'date';
  const dir = query.sortDir ?? 'desc';
  return filtered.sort((a, b) => {
    const va = col === 'amount' ? a.totalAmount : col === 'shippingStatus' ? (SHIPPING_RANK[a.shippingStatus] ?? 99) : a.createdAt;
    const vb = col === 'amount' ? b.totalAmount : col === 'shippingStatus' ? (SHIPPING_RANK[b.shippingStatus] ?? 99) : b.createdAt;
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
}

// Only the 5 combos the toolbar's own sort menu offers are valid — anything
// else (e.g. a hand-edited ?osort=shippingStatus:desc) falls back to the
// default rather than sorting by a combo the UI has no matching label for
// (see AdminOrdersPanel.astro's sortLabels).
const VALID_SORT_COMBOS = new Set(['date:desc', 'date:asc', 'amount:desc', 'amount:asc', 'shippingStatus:asc']);

// Parses the Orders tab's own query params (oq/osort/oship/opay/ostore) into
// an AdminOrderQuery — kept next to filterAndSortOrders so the two things
// that must agree on shape (what a param means, what the filter expects)
// live in one place.
export function parseOrderQuery(sp: URLSearchParams): Required<AdminOrderQuery> {
  const requestedSort = sp.get('osort') ?? 'date:desc';
  const [sortCol, sortDir] = (VALID_SORT_COMBOS.has(requestedSort) ? requestedSort : 'date:desc').split(':') as [AdminOrderSortCol, AdminOrderSortDir];
  return {
    q: (sp.get('oq') ?? '').trim(),
    sortCol,
    sortDir,
    shippingStatus: (sp.get('oship') ?? '').split(',').filter(Boolean),
    paymentStatus: (sp.get('opay') ?? '').split(',').filter(Boolean),
    store: decodeList(sp.get('ostore') ?? ''), // store names may contain commas
  };
}

// Every store name across the whole (unfiltered) order set — the filter
// dropdown's "store" column needs the full list regardless of which page is
// currently shown, not just the stores appearing on the current page.
export function getOrderStoreNames(orders: Order[]): string[] {
  return [...new Set(orders.flatMap((o) => o.items.map((i) => i.storeName)))].sort((a, b) => a.localeCompare(b, 'he'));
}
