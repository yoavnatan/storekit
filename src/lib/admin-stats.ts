/**
 * The admin dashboard's PURE arithmetic — the half of §3 that did not become a query.
 *
 * Everything here takes its data as a parameter, stays synchronous, and is testable without a
 * database. That is deliberate and it is the rule the whole of §3 was decided by: a `GROUP BY`
 * written as a `for` loop belongs in the database (`order-reporting.ts`,
 * `store-products.ts#getProductCountsByStore`), and everything else belongs here, unchanged.
 *
 * What left this module on 2026-08-03: `getStoreRevenueMap` (a group-by over every order),
 * `getProductsByStoreMap` (the whole catalogue, read to produce counts) and the order half of
 * `getPlatformOverview`. What stayed: the shape of a seller card, the shape of a store row, the
 * search/sort/filter predicates, and `orderNetForStore` — which is still the definition the SQL
 * side is written FROM.
 */
import { storeLifecycle, type StoreLifecycle } from './store-status.js';
import type { Seller } from './seller-auth.js';
import type { Store } from './stores.js';
import type { Order } from './orders.js';
import type { StoreProduct, StoreProductCounts } from './store-products.js';
import { EMPTY_STORE_REVENUE, type StoreRevenue } from './order-reporting.js';
import { countsAsRevenue } from './orders.js';
import { businessMonthKey } from './business-day.js';
import { isDemoStore } from './demo-stores.js';

export type { StoreRevenue };

// Net of any discount the seller later applied on that store's slice of the
// order (see orders.ts's StoreSubtotal.discount) — subtotal alone would
// overstate revenue on a discounted order.
export function orderNetForStore(order: Order, storeSlug: string): number {
  // `?.` because a stored row can predate the field (same reason orders.ts guards it when it
  // repoints slugs): every order this code path CREATES has storeSubtotals, but reading one that
  // doesn't must answer 0, not throw — this runs inside order status changes, so an exception
  // here turns a legacy row into a failed cancellation the seller can do nothing about.
  const sub = order.storeSubtotals?.[storeSlug];
  if (!sub) return 0;
  // Floored at zero. The discount is written against the subtotal alone (see the
  // orders API), so this can only go negative on a row stored before that was true —
  // and a report must never show negative revenue for a sale that happened. The row
  // itself is not silently accepted: reconcile.ts reports any discount that exceeds
  // its subtotal, so the data error surfaces as a discrepancy rather than as a
  // number quietly bent back into range here.
  // No rounding: both operands are integer agorot, so the difference is exact. `roundMoney` used
  // to sit here because subtracting two ILS floats produced a tail; there is no tail to trim now.
  return Math.max(0, sub.subtotalAgorot - (sub.discount?.appliedAgorot ?? 0));
}

/** GMV for one order on the SAME basis every per-store surface uses: the sum of its
 *  stores' net subtotals. Deliberately not `order.totalAmount` — that figure adds
 *  shipping and ignores a seller-applied discount, so summing it gave the admin
 *  Overview a "platform revenue" headline that could never be reconciled against
 *  the per-store rows sitting one tab away. Shipping is the carrier's money, not
 *  the platform's or the seller's (AI_INSTRUCTIONS.md → shipping is platform-set,
 *  never a seller margin), so it does not belong in a revenue figure at all. */
export function orderNetTotal(order: Order): number {
  let total = 0;
  // `?? {}` for the same legacy rows orderNetForStore guards above — iterating the
  // field is exactly as exposed as reading it, and this one runs on the admin
  // Overview, where a TypeError takes the whole panel down rather than one figure.
  for (const storeSlug of Object.keys(order.storeSubtotals ?? {})) total += orderNetForStore(order, storeSlug);
  return total;
}

/**
 * The pure twin of `order-reporting.ts#getStoreRevenueBySlug` — the same group-by, over orders the
 * caller already holds.
 *
 * It is no longer on the admin render path (that is the query), and it is kept for the same reason
 * `filterAndSortOrders` and `selectMoneyEvents` are kept beside theirs: it is what makes the rule
 * checkable without a database, and `tests/reporting-invariants.test.ts` runs the two over the same
 * rows and requires the same map. `monthKey` is a parameter rather than `new Date()` inside so both
 * routes are asked about the same month.
 */
export function getStoreRevenueMap(orders: Order[], monthKey: string): Map<string, StoreRevenue> {
  const map = new Map<string, StoreRevenue>();
  for (const order of orders) {
    if (!countsAsRevenue(order)) continue;
    const isThisMonth = businessMonthKey(new Date(order.createdAt)) === monthKey;
    for (const storeSlug of Object.keys(order.storeSubtotals ?? {})) {
      const net = orderNetForStore(order, storeSlug);
      const entry = map.get(storeSlug) ?? { totalRevenueAgorot: 0, monthRevenueAgorot: 0 };
      entry.totalRevenueAgorot += net;
      if (isThisMonth) entry.monthRevenueAgorot += net;
      map.set(storeSlug, entry);
    }
  }
  // The rounding pass that used to close this loop is gone with the unit: summing thousands of
  // integers cannot accumulate an error, which is the whole reason §7.7 asked for integers.
  return map;
}

export interface PlatformOverview {
  totalSellers: number;
  /** REAL stores only. The showcase/demo stores (lib/demo-stores.ts) are excluded:
   *  they are platform-owned fixtures that refuse checkout outright, so counting them
   *  told the owner he had more of a marketplace than he does — the one number on
   *  this screen he would use to judge whether the business is working. */
  totalStores: number;
  /** Showcase stores, surfaced separately rather than hidden, so the count is
   *  explainable against the Stores tab instead of looking like a discrepancy. */
  demoStores: number;
  /** EVERY order row, whatever its payment state — deliberately a different population
   *  from `gmv` below, which is why the card that renders it is labelled as such. */
  totalOrders: number;
  /** Orders that actually counted as money — the population `gmv` is summed over. */
  paidOrders: number;
  /** Gross merchandise value: what buyers paid the sellers, net of seller discounts and
   *  excluding shipping. Same basis as getStoreRevenueMap, so this headline equals the
   *  sum of the per-store rows exactly (asserted in tests/reporting-invariants.test.ts).
   *  It is NOT the platform's own income — that is commission + subscriptions + ad
   *  margin, built by platform-revenue.ts and shown in the Performance tab. */
  gmvAgorot: number;
}

/** The roster half of the Overview card. The three ORDER figures are a query
 *  (`order-reporting.ts#getPlatformOrderTotals`) and are merged in by the caller — this is what is
 *  left once the part that had to scan every order stopped being arithmetic over an array. */
export function getStoreOverview(totalSellers: number, stores: Store[]): Pick<PlatformOverview, 'totalSellers' | 'totalStores' | 'demoStores'> {
  const realStores = stores.filter((s) => !isDemoStore(s));
  return {
    totalSellers,
    totalStores: realStores.length,
    demoStores: stores.length - realStores.length,
  };
}

/**
 * The pure twin of `getPlatformOrderTotals`, over orders the caller already holds.
 *
 * Same arrangement as `getStoreRevenueMap` above: off the render path, kept because it is what
 * `tests/reporting-invariants.test.ts` checks the query against, and because `reconcile.ts` reads
 * it as one of its two independent routes to the same number.
 */
export function getOrderTotals(orders: Order[]): Pick<PlatformOverview, 'totalOrders' | 'paidOrders' | 'gmvAgorot'> {
  // Reporting only (split-payment architecture — see AI_INSTRUCTIONS.md): only
  // orders the processor confirmed as paid AND that were not cancelled count as
  // revenue (countsAsRevenue is the single definition — see orders.ts).
  const paid = orders.filter(countsAsRevenue);
  return {
    totalOrders: orders.length,
    paidOrders: paid.length,
    // Summed through orderNetTotal, not `o.totalAmount`: the latter includes
    // shipping and ignores seller discounts, so this headline and the per-store
    // revenue rows one tab away were two different numbers for the same concept.
    gmvAgorot: paid.reduce((sum, o) => sum + orderNetTotal(o), 0),
  };
}

export interface SellerCardData {
  seller: Seller;
  stores: Array<{ store: Store; products: StoreProduct[]; productCount: number; revenue: StoreRevenue }>;
  totalProducts: number;
  revenue: StoreRevenue; // summed across the seller's own stores
}

/**
 * Cards carry a product COUNT, never a product list — the count is one `GROUP BY` over the whole
 * platform (§3), where this used to read the entire catalogue on every dashboard load.
 *
 * The count is its own field for a reason: it used to be `products.length`, so once the rows were
 * fetched for only the rendered page, every other seller would have reported zero products — a
 * wrong number with no error anywhere. `attachProducts` below is what fills the list in, for the
 * page being rendered and nothing else.
 */
export function getSellerCards(
  sellers: Seller[],
  stores: Store[],
  countsByStore: ReadonlyMap<string, StoreProductCounts>,
  revenueByStore: ReadonlyMap<string, StoreRevenue>,
): SellerCardData[] {
  const storesBySeller = new Map<string, Store[]>();
  for (const store of stores) {
    const list = storesBySeller.get(store.sellerId) ?? [];
    list.push(store);
    storesBySeller.set(store.sellerId, list);
  }

  return sellers
    .map((seller) => {
      const sellerStores = (storesBySeller.get(seller.id) ?? []).map((store) => ({
        store,
        products: [] as StoreProduct[],
        productCount: countsByStore.get(store.id)?.total ?? 0,
        revenue: revenueByStore.get(store.slug) ?? EMPTY_STORE_REVENUE,
      }));
      return {
        seller,
        stores: sellerStores,
        totalProducts: sellerStores.reduce((sum, s) => sum + s.productCount, 0),
        revenue: {
          totalRevenueAgorot: sellerStores.reduce((sum, s) => sum + s.revenue.totalRevenueAgorot, 0),
          monthRevenueAgorot: sellerStores.reduce((sum, s) => sum + s.revenue.monthRevenueAgorot, 0),
        },
      };
    })
    .sort((a, b) => new Date(b.seller.createdAt).getTime() - new Date(a.seller.createdAt).getTime());
}

/** Fill in the product rows for the cards actually being rendered. The per-product block toggle
 *  inside an expanded card is the only thing on this screen that needs a product ROW; everything
 *  else reads `productCount`, which the cards already carry for every seller. */
export function attachProducts(cards: SellerCardData[], productsByStore: ReadonlyMap<string, StoreProduct[]>): SellerCardData[] {
  return cards.map((card) => ({
    ...card,
    stores: card.stores.map((s) => ({ ...s, products: productsByStore.get(s.store.id) ?? [] })),
  }));
}

export interface StoreRow {
  store: Store;
  seller: Seller | undefined;
  productCount: number;
  revenue: StoreRevenue;
  /** Orders this store still owes something on (lib/store-lifecycle.ts). Only ever SHOWN for a
   *  store waiting to close, where it is the answer to the admin's actual question — why has it
   *  not closed yet, and how far off is it. 0 when the caller supplied no counts. */
  openOrders: number;
}

// Flat, top-level "one row per store" view for the admin Stores tab — unlike
// getSellerCards (grouped per-seller, three levels deep with a nested
// accordion), this is a plain list an admin can scan/search across every
// store regardless of who owns it. Sorted by store name since that's what an
// admin searching for a specific store is scanning for, not seller identity.
export function getStoreRows(
  stores: Store[],
  sellers: Seller[],
  countsByStore: ReadonlyMap<string, StoreProductCounts>,
  revenueByStore: ReadonlyMap<string, StoreRevenue>,
  openOrdersByStore: ReadonlyMap<string, number> = new Map(),
): StoreRow[] {
  const sellerById = new Map(sellers.map((s) => [s.id, s]));
  return stores
    .map((store) => ({
      store,
      seller: sellerById.get(store.sellerId),
      productCount: countsByStore.get(store.id)?.total ?? 0,
      revenue: revenueByStore.get(store.slug) ?? EMPTY_STORE_REVENUE,
      openOrders: openOrdersByStore.get(store.slug) ?? 0,
    }))
    .sort((a, b) => a.store.name.localeCompare(b.store.name, 'he'));
}

function normSearch(s: string): string {
  return s.toLowerCase().trim();
}

// Plain substring search (not the Hebrew nikud-normalizing matcher in
// product-listing.ts — that's tuned for shopper-facing product search; admin
// name/email/slug fields don't need it) — same rule the tabs' own search
// boxes already applied client-side before pagination made that need to move
// server-side.
function sellerSearchMatch(q: string, { seller, stores }: SellerCardData): boolean {
  const hay = `${seller.name} ${seller.email} ${stores.map((s) => s.store.name).join(' ')}`.toLowerCase();
  return hay.includes(q);
}

function storeSearchMatch(q: string, { store, seller }: StoreRow): boolean {
  const hay = `${store.name} ${store.slug} ${seller?.name ?? ''} ${seller?.email ?? ''}`.toLowerCase();
  return hay.includes(q);
}

// Sort/filter dimensions with real signal for a cross-store admin view
// (same reasoning as admin-orders-filter.ts's own header comment) — join
// date/revenue/store count for Sellers, name/revenue/product count for
// Stores, and a single "has a blocked store" status filter since that's the
// only binary moderation signal either tab actually carries.
export type AdminSellerSortCol = 'joined' | 'revenue' | 'stores';
export type AdminStoreSortCol = 'name' | 'revenue' | 'products';
export type AdminSortDir = 'asc' | 'desc';

export interface AdminSellerQuery {
  q: string;
  sortCol: AdminSellerSortCol;
  sortDir: AdminSortDir;
  blockedOnly: boolean;
  /**
   * Narrow to sellers in one payout state, or `'all'`.
   *
   * It exists because the per-seller payout TABLE does not any more: the owner asked for those
   * facts inside the seller cards rather than as a second roster of the same people (סשן א׳ §3),
   * and the one thing that roster could do which a card cannot is answer "who is stuck". A card
   * shows one seller; a filter finds them among a thousand. Without this, removing the table would
   * have removed a real capability along with the duplication.
   */
  payoutState: PayoutStateFilter;
}

/** `payable` / `no_bank` / `below_minimum` from `payout-run.ts`, plus "don't filter". The two
 *  states with nothing to act on (`settled`, `already_paid`) are deliberately not offered: they are
 *  most sellers most months, so a chip for them is a chip that selects everybody. */
export type PayoutStateFilter = 'all' | 'payable' | 'no_bank' | 'below_minimum';
export const PAYOUT_STATE_FILTERS: readonly PayoutStateFilter[] = ['all', 'payable', 'no_bank', 'below_minimum'];

export interface AdminStoreQuery {
  q: string;
  sortCol: AdminStoreSortCol;
  sortDir: AdminSortDir;
  /** Which lifecycle state to list, or every one. Replaces the old blocked-only toggle: with five
   *  states (lib/store-status.ts) a yes/no switch could no longer answer "which stores did their
   *  sellers pause, and which are waiting to close". */
  state: StoreStateFilter;
  /**
   * Only stores with an empty catalogue — what the "לתשומת לב" TAB used to be (owner, סשן ב׳ §1:
   * *"נראית לי מיותרת. מה היא בעצם אומרת לנו?"*). The honest answer was: one thing, "0 מוצרים",
   * about the same stores this tab already lists, with the count already printed on every row. So
   * it is a filter here instead of a tab of its own, and it composes with the state chips and the
   * search — which the tab could not do, because it was a separate list with no filters at all.
   *
   * Orthogonal to `state` on purpose: a paused store can also be empty, and folding "empty" into
   * the lifecycle enum would have made those two facts unable to be true at once.
   */
  emptyOnly: boolean;
}

export type StoreStateFilter = StoreLifecycle | 'all';

/** How many stores sit in each state, over the WHOLE list — computed before any filter, so the
 *  chips keep showing what exists while one of them is selected. Search deliberately does narrow
 *  them: "how many of the stores called X are paused" is a real question, "how many are paused
 *  out of the ones I am already looking at only the paused of" is not. */
export function countStoreStates(rows: StoreRow[]): Record<StoreStateFilter, number> {
  const counts = { all: rows.length, active: 0, paused: 0, closing: 0, closed: 0, blocked: 0 };
  for (const r of rows) counts[storeLifecycle(r.store)]++;
  return counts;
}

/** Stores with nothing in the catalogue — the count behind the "ללא מוצרים" chip, and the number
 *  the overview card shows. Counted over every store like the state counts beside it, so selecting
 *  the chip does not change what it says. */
export function countEmptyStores(rows: StoreRow[]): number {
  return rows.reduce((n, r) => (r.productCount === 0 ? n + 1 : n), 0);
}

/**
 * @param payoutStateBySeller sellerId → the state `payout-run.ts#planPayouts` put them in. Passed
 *   in rather than read here for the reason this whole module is pure: a GROUP BY belongs in the
 *   database and everything else belongs in a function a test can call with three literals. A
 *   seller absent from the map has no released balance at all, which is `settled` — so the three
 *   offered filters correctly exclude them.
 */
export function filterAndSortSellerCards(
  cards: SellerCardData[],
  query: AdminSellerQuery,
  payoutStateBySeller?: ReadonlyMap<string, string>,
): SellerCardData[] {
  const nq = normSearch(query.q);
  const filtered = cards.filter((c) => {
    if (nq && !sellerSearchMatch(nq, c)) return false;
    if (query.blockedOnly && !c.stores.some((s) => s.store.blocked)) return false;
    if (query.payoutState !== 'all' && payoutStateBySeller?.get(c.seller.id) !== query.payoutState) return false;
    return true;
  });

  const dir = query.sortDir === 'asc' ? 1 : -1;
  return filtered.sort((a, b) => {
    const va = query.sortCol === 'revenue' ? a.revenue.totalRevenueAgorot : query.sortCol === 'stores' ? a.stores.length : new Date(a.seller.createdAt).getTime();
    const vb = query.sortCol === 'revenue' ? b.revenue.totalRevenueAgorot : query.sortCol === 'stores' ? b.stores.length : new Date(b.seller.createdAt).getTime();
    return va < vb ? -dir : va > vb ? dir : 0;
  });
}

export function filterAndSortStoreRows(rows: StoreRow[], query: AdminStoreQuery): StoreRow[] {
  const nq = normSearch(query.q);
  const filtered = rows.filter((r) => {
    if (nq && !storeSearchMatch(nq, r)) return false;
    if (query.state !== 'all' && storeLifecycle(r.store) !== query.state) return false;
    if (query.emptyOnly && r.productCount > 0) return false;
    return true;
  });

  const dir = query.sortDir === 'asc' ? 1 : -1;
  return filtered.sort((a, b) => {
    if (query.sortCol === 'name') {
      const cmp = a.store.name.localeCompare(b.store.name, 'he');
      return dir === 1 ? cmp : -cmp;
    }
    const va = query.sortCol === 'revenue' ? a.revenue.totalRevenueAgorot : a.productCount;
    const vb = query.sortCol === 'revenue' ? b.revenue.totalRevenueAgorot : b.productCount;
    return va < vb ? -dir : va > vb ? dir : 0;
  });
}

// Only the 5 combos each tab's own sort menu offers are valid — mirrors
// admin-orders-filter.ts's own VALID_SORT_COMBOS reasoning (a hand-edited
// query param falls back to the default rather than sorting by a combo the
// UI has no matching label for).
const VALID_SELLER_SORT_COMBOS = new Set(['joined:desc', 'joined:asc', 'revenue:desc', 'revenue:asc', 'stores:desc']);

export function parseSellerQuery(sp: URLSearchParams): AdminSellerQuery {
  const requested = sp.get('ssort') ?? 'joined:desc';
  const [sortCol, sortDir] = (VALID_SELLER_SORT_COMBOS.has(requested) ? requested : 'joined:desc').split(':') as [AdminSellerSortCol, AdminSortDir];
  // Whitelisted, like every other filter param here: a hand-edited `?spayout=nonsense` falls back
  // to "no filter" rather than silently matching nothing and reading as "no sellers exist".
  const rawPayout = sp.get('spayout') as PayoutStateFilter | null;
  const payoutState: PayoutStateFilter = PAYOUT_STATE_FILTERS.includes(rawPayout as PayoutStateFilter) ? rawPayout! : 'all';
  return { q: (sp.get('sq') ?? '').trim(), sortCol, sortDir, blockedOnly: sp.get('sblocked') === '1', payoutState };
}

const VALID_STORE_SORT_COMBOS = new Set(['name:asc', 'name:desc', 'revenue:desc', 'revenue:asc', 'products:desc']);

/** Every value the state filter accepts — the chip row's order, and the whitelist a hand-edited
 *  query param is checked against. */
export const STORE_STATE_FILTERS = ['all', 'active', 'paused', 'closing', 'closed', 'blocked'] as const;

export function parseStoreQuery(sp: URLSearchParams): AdminStoreQuery {
  const requested = sp.get('stsort') ?? 'name:asc';
  const [sortCol, sortDir] = (VALID_STORE_SORT_COMBOS.has(requested) ? requested : 'name:asc').split(':') as [AdminStoreSortCol, AdminSortDir];
  // `stblocked=1` is the parameter this filter used when it was a yes/no toggle. Still honoured
  // so an admin's existing bookmark keeps meaning what it meant, and so a link shared before this
  // change doesn't silently widen to every store.
  const requestedState = sp.get('ststate') ?? (sp.get('stblocked') === '1' ? 'blocked' : 'all');
  const state = (STORE_STATE_FILTERS as readonly string[]).includes(requestedState)
    ? requestedState as StoreStateFilter
    : 'all';
  return { q: (sp.get('stq') ?? '').trim(), sortCol, sortDir, state, emptyOnly: sp.get('stempty') === '1' };
}

