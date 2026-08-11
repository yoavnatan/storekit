import type { Order } from './orders.js';
import { SHIPPING_STATUS_RULES, type ShippingStatus } from './order-status-rules.js';
import { decodeList } from './admin-nav.js';
import { storeSliceTotalAgorot } from './order-totals.js';

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
/**
 * The four urgency groups, in order, DERIVED from the status table rather than listed here —
 * `tests/money-guards.test.ts` refuses a second copy of those statuses, and it is right to: a
 * status added to `order-status-rules.ts` has to arrive in this sort on the same commit, not on
 * the day someone notices it sorting last.
 *
 * The ranking is a reading of three columns, and each says whose turn it is:
 *   0 — `sellerOwesAction`: the only rows the seller can act on. Top of the list.
 *   1 — the courier has it (`buyerAwaiting`, nothing owed by the seller).
 *   2 — done and not terminal: delivered.
 *   3 — `terminal`: cancelled, nothing left to happen.
 *
 * It is the shape BOTH consumers need: the JS sort reads a rank out of the map below, and the SQL
 * sort (`orders.ts#getSellerOrdersPage`) is handed the two flat arrays as query parameters.
 */
export const URGENCY_GROUPS: readonly (readonly string[])[] = (() => {
  const statuses = Object.keys(SHIPPING_STATUS_RULES) as ShippingStatus[];
  const rank = (s: ShippingStatus): number => {
    const rule = SHIPPING_STATUS_RULES[s];
    if (rule.terminal) return 3;
    if (rule.sellerOwesAction) return 0;
    return rule.buyerAwaiting ? 1 : 2;
  };
  return [0, 1, 2, 3].map((r) => statuses.filter((s) => rank(s) === r));
})();
/** `URGENCY_GROUPS` flattened into the two parallel arrays a query can take: status → its rank. */
export const URGENCY_STATUSES: readonly string[] = URGENCY_GROUPS.flat();
export const URGENCY_RANKS: readonly number[] = URGENCY_GROUPS.flatMap((g, i) => g.map(() => i));

const URGENCY_GROUP: Record<string, number> = Object.fromEntries(
  URGENCY_GROUPS.flatMap((group, rank) => group.map((status) => [status, rank])),
);
/** The statuses the seller's Orders filter menu can express, in workflow order — the one
 *  source both this module and the client toolbar (scripts/dashboard/orders.ts) read.
 *  'ready' (ממתין לאיסוף) is deliberately absent: no seller can set it today, and it returns
 *  as a carrier-driven state once shipping is wired (GO_LIVE §5) — same omission as the admin
 *  orders filter. A status the menu cannot show must not sit in the default selection either,
 *  or the first filter change silently drops rows the page had already shown. */
export const ORDER_FILTER_STATUSES: string[] = (Object.keys(SHIPPING_STATUS_RULES) as ShippingStatus[])
  .filter((s) => s !== 'ready');

/** "Active" = the order is still live: neither delivered nor terminal. Derived from
 *  the status table (order-status-rules.ts) rather than re-listed, so a status added
 *  there is filterable here on the same commit instead of being silently absent from
 *  the seller's default view. */
export const ORDER_ACTIVE_STATUSES: string[] = ORDER_FILTER_STATUSES
  .filter((s) => s !== 'delivered' && !SHIPPING_STATUS_RULES[s as ShippingStatus].terminal);

export interface SellerOrderQuery {
  q: string;
  sortCol: SellerOrderSortCol;
  sortDir: SellerOrderSortDir;
  shippingStatus: string[];
}

const VALID_SORT_COLS = new Set<string>(['date', 'amount', 'urgency']);

/** Matches the money journal's ceiling — one number, one reason, in two places that both take a
 *  free-text term off a URL. */
const MAX_SEARCH_LENGTH = 200;

export function parseSellerOrderQuery(sp: URLSearchParams): SellerOrderQuery {
  const [rawCol, rawDir] = (sp.get('osort') ?? 'date:desc').split(':');
  const sortCol = (VALID_SORT_COLS.has(rawCol ?? '') ? rawCol : 'date') as SellerOrderSortCol;
  const sortDir: SellerOrderSortDir = rawDir === 'asc' ? 'asc' : 'desc';
  // No ?ostatus at all → the toolbar's own default ("active" preset,
  // matching what a fresh page load already showed pre-pagination). An
  // explicit empty value (?ostatus=) means "cleared" — show every status.
  const hasStatusParam = sp.has('ostatus');
  return {
    // Capped for the same reason the money journal's box is (admin-moneylog-filter.ts): the term is
    // request-supplied and now travels into a query, and a query string can carry ~16KB. No search
    // anyone types is longer, so the cap costs nothing and removes the amplification.
    q: (sp.get('oq') ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
    sortCol,
    sortDir,
    shippingStatus: hasStatusParam ? decodeList(sp.get('ostatus') ?? '') : ORDER_ACTIVE_STATUSES,
  };
}

function orderAmount(o: Order, storeSlug: string): number {
  // Same total the card shows (order-totals.ts) — sorting by a pre-discount figure put a
  // discounted order above one that actually took more money.
  return storeSliceTotalAgorot(o.storeSubtotals[storeSlug]);
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
