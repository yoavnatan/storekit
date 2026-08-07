import type { Order } from './orders.js';
import { decodeList } from './admin-nav.js';
import { SHIPPING_PIPELINE_ORDER } from './order-status-rules.js';

// Server-side counterpart of the admin Orders tab's search/sort/filter
// toolbar (src/scripts/admin/orders-filter.ts) — pagination meant the
// toolbar could no longer just show/hide DOM cards already on the page, so
// filtering+sorting had to move here and run over the full order list before
// slicing to a page, the same way product-listing.ts already does for the
// public store page.
//
// **The page itself is a query now (§3, 2026-08-03): `orders.ts#getAdminOrdersPage`.** Reading
// every order on the platform to show fifteen of them is the shape §3 exists to remove. What stays
// here is the vocabulary — what each query parameter means — plus `filterAndSortOrders`, which is
// no longer on the render path but IS the query's unit-testable twin: `tests/admin-orders-page.test.ts`
// runs the two over the same rows and requires the same list, so the rules cannot drift apart
// silently. Same arrangement `selectMoneyEvents` has with `getMoneyEvents`.
//
// **What the twin does and does not cover, as of 2026-08-07.** The query now pages by PURCHASE
// (`checkout-group.ts`), not by order row: it picks the checkout groups whose rows match, and
// returns every row of those groups. `filterAndSortOrders` is still row-level, so the two agree
// exactly while each checkout is one row — which is every case in
// `tests/admin-orders-page.test.ts`'s fixture, and so the twin still pins the vocabulary it exists
// to pin: what the search matches, which sorts exist, how a tie breaks. It does NOT define the
// grouping, and must not be extended to; that is `tests/admin-orders-grouping.test.ts`, on a
// fixture built from real multi-store checkouts.
export type AdminOrderSortCol = 'date' | 'amount' | 'shippingStatus';
export type AdminOrderSortDir = 'asc' | 'desc';

/** Fulfilment order as a LIST rather than a rank map, because that is the shape both consumers
 *  need: the JS sort reads an index out of it, and the SQL sort is handed it as a `text[]` for
 *  `array_position`. Derived from the status table (`order-status-rules.ts`) — a status missing
 *  from it (only 'cancelled', the terminal one) sorts last in both. */
export const SHIPPING_SORT_ORDER: readonly string[] = SHIPPING_PIPELINE_ORDER;

const rankOf = (status: string): number => {
  const i = SHIPPING_SORT_ORDER.indexOf(status);
  return i === -1 ? 99 : i;
};

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
    const va = col === 'amount' ? a.totalAgorot : col === 'shippingStatus' ? rankOf(a.shippingStatus) : a.createdAt;
    const vb = col === 'amount' ? b.totalAgorot : col === 'shippingStatus' ? rankOf(b.shippingStatus) : b.createdAt;
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
//
// The names come from `order-reporting.ts#getAllOrderStoreNames` (one `SELECT DISTINCT`) now
// rather than from a pass over every order; the Hebrew ordering stays here because it is a
// `localeCompare('he')` and a database collation is not the same function.
export function sortOrderStoreNames(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'he'));
}
