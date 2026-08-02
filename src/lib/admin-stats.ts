import { storeLifecycle, type StoreLifecycle } from './store-status.js';
import type { Seller } from './seller-auth.js';
import type { Store } from './stores.js';
import type { Order } from './orders.js';
import { countsAsRevenue } from './orders.js';
import { getAllProducts, type StoreProduct } from './store-products.js';
import { businessMonthKey } from './business-day.js';
import { isDemoStore } from './demo-stores.js';
import { roundMoney } from './money.js';

export interface StoreRevenue {
  totalRevenue: number; // all-time, paid orders only, net of any seller-applied discount
  monthRevenue: number; // current calendar month, same basis
}

const EMPTY_REVENUE: StoreRevenue = { totalRevenue: 0, monthRevenue: 0 };

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
  return Math.max(0, roundMoney(sub.subtotal - (sub.discount?.applied ?? 0)));
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
  return roundMoney(total);
}

// One pass over all orders, keyed by storeSlug — callers (getSellerCards/
// getStoreRows) look up per-store, then sum across a seller's own stores for
// the seller-level total. Reporting only (see AI_INSTRUCTIONS.md → payment
// architecture) — mirrors getPlatformOverview's paid-orders-only revenue rule.
export function getStoreRevenueMap(orders: Order[]): Map<string, StoreRevenue> {
  const map = new Map<string, StoreRevenue>();
  // "This month" on the BUSINESS calendar (business-day.ts) — the same definition
  // the performance tab buckets by. These were two different months: this read the
  // server's local calendar, the performance tab read UTC.
  const curMonth = businessMonthKey(new Date());
  for (const order of orders) {
    if (!countsAsRevenue(order)) continue;
    const isThisMonth = businessMonthKey(new Date(order.createdAt)) === curMonth;
    for (const storeSlug of Object.keys(order.storeSubtotals ?? {})) {
      const net = orderNetForStore(order, storeSlug);
      const entry = map.get(storeSlug) ?? { totalRevenue: 0, monthRevenue: 0 };
      entry.totalRevenue += net;
      if (isThisMonth) entry.monthRevenue += net;
      map.set(storeSlug, entry);
    }
  }
  for (const entry of map.values()) {
    entry.totalRevenue = roundMoney(entry.totalRevenue);
    entry.monthRevenue = roundMoney(entry.monthRevenue);
  }
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
  gmv: number;
}

export function getPlatformOverview(sellers: Seller[], stores: Store[], orders: Order[]): PlatformOverview {
  // Reporting only (split-payment architecture — see AI_INSTRUCTIONS.md): only
  // orders the processor confirmed as paid AND that were not cancelled count as
  // revenue (countsAsRevenue is the single definition — see orders.ts).
  const paid = orders.filter(countsAsRevenue);
  const realStores = stores.filter((s) => !isDemoStore(s));
  return {
    totalSellers: sellers.length,
    totalStores: realStores.length,
    demoStores: stores.length - realStores.length,
    totalOrders: orders.length,
    paidOrders: paid.length,
    // Summed through orderNetTotal, not `o.totalAmount`: the latter includes
    // shipping and ignores seller discounts, so this headline and the per-store
    // revenue rows one tab away were two different numbers for the same concept.
    gmv: roundMoney(paid.reduce((sum, o) => sum + orderNetTotal(o), 0)),
  };
}

// One read of the whole catalog, grouped by store — callers pass the resulting
// map into getSellerCards/getStoresNeedingAttention instead of each querying per
// store. Carries the full product list (not just a count) so the sellers tab can
// also surface a per-product "block" toggle (see AdminSellersPanel.astro) without
// a second read. Inherits getAllProducts' open debt: it fetches every product in
// the platform (§3), and pages when its neighbours do.
export async function getProductsByStoreMap(): Promise<Map<string, StoreProduct[]>> {
  const map = new Map<string, StoreProduct[]>();
  for (const product of await getAllProducts()) {
    const list = map.get(product.storeId) ?? [];
    list.push(product);
    map.set(product.storeId, list);
  }
  return map;
}

export interface SellerCardData {
  seller: Seller;
  stores: Array<{ store: Store; products: StoreProduct[]; revenue: StoreRevenue }>;
  totalProducts: number;
  revenue: StoreRevenue; // summed across the seller's own stores
}

export function getSellerCards(sellers: Seller[], stores: Store[], productsByStore: Map<string, StoreProduct[]>, revenueByStore: Map<string, StoreRevenue>): SellerCardData[] {
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
        products: productsByStore.get(store.id) ?? [],
        revenue: revenueByStore.get(store.slug) ?? EMPTY_REVENUE,
      }));
      return {
        seller,
        stores: sellerStores,
        totalProducts: sellerStores.reduce((sum, s) => sum + s.products.length, 0),
        revenue: {
          totalRevenue: sellerStores.reduce((sum, s) => sum + s.revenue.totalRevenue, 0),
          monthRevenue: sellerStores.reduce((sum, s) => sum + s.revenue.monthRevenue, 0),
        },
      };
    })
    .sort((a, b) => new Date(b.seller.createdAt).getTime() - new Date(a.seller.createdAt).getTime());
}

// Informational only — never written back to the Store record and never
// read by any registration/checkout path. Purely a heads-up for the owner.
function attentionReasons(_store: Store, productCount: number): string[] {
  const reasons: string[] = [];
  if (productCount === 0) reasons.push('0 מוצרים');
  return reasons;
}

export function isStoreIncomplete(store: Store, productCount: number): boolean {
  return attentionReasons(store, productCount).length > 0;
}

export interface AttentionEntry {
  store: Store;
  seller: Seller | undefined;
  reasons: string[];
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
  productsByStore: Map<string, StoreProduct[]>,
  revenueByStore: Map<string, StoreRevenue>,
  openOrdersByStore: Map<string, number> = new Map(),
): StoreRow[] {
  const sellerById = new Map(sellers.map((s) => [s.id, s]));
  return stores
    .map((store) => ({
      store,
      seller: sellerById.get(store.sellerId),
      productCount: productsByStore.get(store.id)?.length ?? 0,
      revenue: revenueByStore.get(store.slug) ?? EMPTY_REVENUE,
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
}

export interface AdminStoreQuery {
  q: string;
  sortCol: AdminStoreSortCol;
  sortDir: AdminSortDir;
  /** Which lifecycle state to list, or every one. Replaces the old blocked-only toggle: with five
   *  states (lib/store-status.ts) a yes/no switch could no longer answer "which stores did their
   *  sellers pause, and which are waiting to close". */
  state: StoreStateFilter;
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

export function filterAndSortSellerCards(cards: SellerCardData[], query: AdminSellerQuery): SellerCardData[] {
  const nq = normSearch(query.q);
  const filtered = cards.filter((c) => {
    if (nq && !sellerSearchMatch(nq, c)) return false;
    if (query.blockedOnly && !c.stores.some((s) => s.store.blocked)) return false;
    return true;
  });

  const dir = query.sortDir === 'asc' ? 1 : -1;
  return filtered.sort((a, b) => {
    const va = query.sortCol === 'revenue' ? a.revenue.totalRevenue : query.sortCol === 'stores' ? a.stores.length : new Date(a.seller.createdAt).getTime();
    const vb = query.sortCol === 'revenue' ? b.revenue.totalRevenue : query.sortCol === 'stores' ? b.stores.length : new Date(b.seller.createdAt).getTime();
    return va < vb ? -dir : va > vb ? dir : 0;
  });
}

export function filterAndSortStoreRows(rows: StoreRow[], query: AdminStoreQuery): StoreRow[] {
  const nq = normSearch(query.q);
  const filtered = rows.filter((r) => {
    if (nq && !storeSearchMatch(nq, r)) return false;
    if (query.state !== 'all' && storeLifecycle(r.store) !== query.state) return false;
    return true;
  });

  const dir = query.sortDir === 'asc' ? 1 : -1;
  return filtered.sort((a, b) => {
    if (query.sortCol === 'name') {
      const cmp = a.store.name.localeCompare(b.store.name, 'he');
      return dir === 1 ? cmp : -cmp;
    }
    const va = query.sortCol === 'revenue' ? a.revenue.totalRevenue : a.productCount;
    const vb = query.sortCol === 'revenue' ? b.revenue.totalRevenue : b.productCount;
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
  return { q: (sp.get('sq') ?? '').trim(), sortCol, sortDir, blockedOnly: sp.get('sblocked') === '1' };
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
  return { q: (sp.get('stq') ?? '').trim(), sortCol, sortDir, state };
}

export function getStoresNeedingAttention(stores: Store[], sellers: Seller[], productsByStore: Map<string, StoreProduct[]>): AttentionEntry[] {
  const sellerById = new Map(sellers.map((s) => [s.id, s]));
  return stores
    .map((store) => {
      const productCount = productsByStore.get(store.id)?.length ?? 0;
      const reasons = attentionReasons(store, productCount);
      if (reasons.length === 0) return null;
      return { store, seller: sellerById.get(store.sellerId), reasons };
    })
    .filter((entry): entry is AttentionEntry => entry !== null);
}
