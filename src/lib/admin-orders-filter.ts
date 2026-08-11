import type { Order } from './orders.js';
import type { OrderSellerOption } from './order-reporting.js';
import { PAYOUT_FILTER_VALUES, orderPayoutLine, payoutFilterValue } from './order-payout-line.js';
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
  /**
   * Store SLUGS, and the only form the "מוכר/ת" filter ever reaches an engine in.
   *
   * The admin picks a seller; a seller is an account, and neither this function nor the SQL can see
   * which stores an account owns without a roster read. So the resolution happens once, at the page
   * (`resolveOrderQuery` below, over `getOrderSellerOptions`), and both engines filter on the same
   * flat list of slugs — which is a rule each of them can state in full, and therefore one the twin
   * test can hold them to.
   *
   * Slugs and not names: two stores may share a name, `order_items.store_slug` is what the seller
   * dashboard is keyed by, and the seller's retired slugs are in this list too (see
   * `OrderSellerOption.storeSlugs`).
   */
  storeSlug?: string[];
  /**
   * Where each slice's money stands (`payout-hold.ts#PAYOUT_CLASS_SQL`) — the same five values the
   * seller's own orders tab filters by.
   *
   * It exists because the admin could see a large held balance and had no way to reach the orders
   * behind it (owner, 2026-08-11). The seller's copy of this screen has had the filter all along
   * and the admin's did not, which is the inconsistency he named.
   */
  payout?: string[];
}

function orderStoreNames(o: Order): string[] {
  return [...new Set(o.items.map((i) => i.storeName))];
}

function orderSearchHaystack(o: Order, stores: string[]): string {
  return `${o.id} ${o.checkoutRef ?? ''} ${o.buyerName} ${o.buyerEmail} ${o.buyerPhone} ${stores.join(' ')}`.toLowerCase();
}

/**
 * Every payout state this order's slices are in — one per store, because a five-store purchase can
 * have one seller shipped and another not, and the two halves of its money are in different places.
 *
 * The same `orderPayoutLine` the order CARD renders from, so a row that says "משתחרר ב-24" and the
 * filter that finds it are one derivation. `PAYOUT_CLASS_SQL` is the SQL twin of this, and
 * `tests/admin-orders-page.test.ts` runs both over the same rows.
 */
function orderPayoutStates(o: Order): Set<string> {
  const slices = Object.entries(o.storeSubtotals ?? {});
  // An order with no per-store rows still HAS a payout state — it is one slice by definition, and
  // dropping it here would quietly exclude such orders from every payout filter.
  const methods = slices.length ? slices.map(([, s]) => s?.deliveryMethod ?? null) : [null];
  return new Set(methods.map((deliveryMethod) => payoutFilterValue(orderPayoutLine({
    paymentStatus: o.paymentStatus,
    shippingStatus: o.shippingStatus,
    paidAt: o.paidAt ?? null,
    deliveredAt: o.deliveredAt ?? null,
    deliveryMethod,
  }))));
}

export function filterAndSortOrders(orders: Order[], query: AdminOrderQuery): Order[] {
  const q = query.q?.trim().toLowerCase() ?? '';
  const shipSet = query.shippingStatus?.length ? new Set(query.shippingStatus) : null;
  const paySet = query.paymentStatus?.length ? new Set(query.paymentStatus) : null;
  const storeSet = query.store?.length ? new Set(query.store) : null;
  const slugSet = query.storeSlug?.length ? new Set(query.storeSlug) : null;
  const payoutSet = query.payout?.length ? new Set(query.payout) : null;

  const filtered = orders.filter((o) => {
    if (shipSet && !shipSet.has(o.shippingStatus)) return false;
    if (paySet && !paySet.has(o.paymentStatus)) return false;
    // ANY slice, matching the `EXISTS` in the query and the rule it states: a purchase matches if
    // part of it does, and then the whole purchase is shown.
    if (payoutSet && ![...orderPayoutStates(o)].some((s) => payoutSet.has(s))) return false;
    // ANY line, for the same reason the payout filter is an ANY: a purchase spanning two sellers
    // belongs to both of them, and picking one must show the whole purchase rather than half of it.
    if (slugSet && !o.items.some((i) => slugSet.has(i.storeSlug))) return false;
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

/**
 * What the URL says, before anything that needs the database.
 *
 * It is `AdminOrderQuery` minus `storeSlug` plus `seller`, and the swap is the point: `oseller`
 * names ACCOUNTS and the engines filter by SLUG, so the parsed shape deliberately cannot be handed
 * to a query — `resolveOrderQuery` is the one step that turns one into the other, and a caller that
 * skips it gets a type error rather than a screen that quietly ignores the filter.
 */
export interface ParsedOrderQuery extends Required<Omit<AdminOrderQuery, 'storeSlug'>> {
  /** Seller ids, as ticked in the filter menu. */
  seller: string[];
}

// Parses the Orders tab's own query params (oq/osort/oship/opay/ostore/oseller) into
// an AdminOrderQuery — kept next to filterAndSortOrders so the two things
// that must agree on shape (what a param means, what the filter expects)
// live in one place.
export function parseOrderQuery(sp: URLSearchParams): ParsedOrderQuery {
  const requestedSort = sp.get('osort') ?? 'date:desc';
  const [sortCol, sortDir] = (VALID_SORT_COMBOS.has(requestedSort) ? requestedSort : 'date:desc').split(':') as [AdminOrderSortCol, AdminOrderSortDir];
  return {
    q: (sp.get('oq') ?? '').trim(),
    sortCol,
    sortDir,
    shippingStatus: (sp.get('oship') ?? '').split(',').filter(Boolean),
    paymentStatus: (sp.get('opay') ?? '').split(',').filter(Boolean),
    store: decodeList(sp.get('ostore') ?? ''), // store names may contain commas
    // Whitelisted against the vocabulary, like every other filter here: a hand-edited value must
    // fall back to "no filter" rather than reach the query and match nothing, which on this screen
    // would read as "there are no orders" instead of "that word means nothing".
    payout: (sp.get('opayout') ?? '').split(',').filter((v) => (PAYOUT_FILTER_VALUES as readonly string[]).includes(v)),
    // Ids, so no `encodeList` — a uuid has no commas to escape. Whether each one names a real
    // seller is settled by `resolveOrderQuery`, which has the roster; here they are just words.
    seller: (sp.get('oseller') ?? '').split(',').filter(Boolean),
  };
}

/**
 * The parsed URL, as the two engines take it: `seller` resolved to the slugs to filter by.
 *
 * Unknown ids contribute nothing, exactly like a hand-edited `opayout` value — so a stale link
 * degrades to "no seller filter" rather than to a screen that says the platform has no orders. A
 * seller who reached the option list has sold something and therefore always has at least one slug,
 * which is why "resolved to nothing" cannot happen for a real selection.
 */
export function resolveOrderQuery(parsed: ParsedOrderQuery, sellers: readonly OrderSellerOption[]): AdminOrderQuery {
  const { seller, ...query } = parsed;
  if (!seller.length) return query;
  const wanted = new Set(seller);
  const slugs = new Set(sellers.filter((s) => wanted.has(s.id)).flatMap((s) => s.storeSlugs));
  // No key at all rather than an empty one: both engines read an empty list as "no filter" anyway,
  // and leaving the key out is the version of that which cannot be misread at a call site.
  return slugs.size ? { ...query, storeSlug: [...slugs] } : query;
}

/** The filter menu's seller list, in the order it is drawn: by name, Hebrew-aware, same call
 *  `sortOrderStoreNames` makes for the store column beside it. */
export function sortSellerOptions(sellers: readonly OrderSellerOption[]): OrderSellerOption[] {
  return [...sellers].sort((a, b) => a.name.localeCompare(b.name, 'he') || a.email.localeCompare(b.email));
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
