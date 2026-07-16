import type { Seller } from './seller-auth.js';
import type { Store } from './stores.js';
import type { Order } from './orders.js';
import { readProducts, type StoreProduct } from './store-products.js';

export interface StoreRevenue {
  totalRevenue: number; // all-time, paid orders only, net of any seller-applied discount
  monthRevenue: number; // current calendar month, same basis
}

const EMPTY_REVENUE: StoreRevenue = { totalRevenue: 0, monthRevenue: 0 };

// Net of any discount the seller later applied on that store's slice of the
// order (see orders.ts's StoreSubtotal.discount) — subtotal alone would
// overstate revenue on a discounted order.
export function orderNetForStore(order: Order, storeSlug: string): number {
  const sub = order.storeSubtotals[storeSlug];
  if (!sub) return 0;
  return sub.subtotal - (sub.discount?.applied ?? 0);
}

// One pass over all orders, keyed by storeSlug — callers (getSellerCards/
// getStoreRows) look up per-store, then sum across a seller's own stores for
// the seller-level total. Reporting only (see AI_INSTRUCTIONS.md → payment
// architecture) — mirrors getPlatformOverview's paid-orders-only revenue rule.
export function getStoreRevenueMap(orders: Order[]): Map<string, StoreRevenue> {
  const map = new Map<string, StoreRevenue>();
  const now = new Date();
  const curMonth = now.getMonth();
  const curYear = now.getFullYear();
  for (const order of orders) {
    if (order.paymentStatus !== 'paid') continue;
    const created = new Date(order.createdAt);
    const isThisMonth = created.getMonth() === curMonth && created.getFullYear() === curYear;
    for (const storeSlug of Object.keys(order.storeSubtotals)) {
      const net = orderNetForStore(order, storeSlug);
      const entry = map.get(storeSlug) ?? { totalRevenue: 0, monthRevenue: 0 };
      entry.totalRevenue += net;
      if (isThisMonth) entry.monthRevenue += net;
      map.set(storeSlug, entry);
    }
  }
  return map;
}

export interface PlatformOverview {
  totalSellers: number;
  totalStores: number;
  totalOrders: number;
  totalRevenue: number;
}

export function getPlatformOverview(sellers: Seller[], stores: Store[], orders: Order[]): PlatformOverview {
  return {
    totalSellers: sellers.length,
    totalStores: stores.length,
    totalOrders: orders.length,
    // Reporting only (split-payment architecture — see AI_INSTRUCTIONS.md):
    // only orders the processor actually confirmed as paid count as revenue.
    totalRevenue: orders
      .filter((o) => o.paymentStatus === 'paid')
      .reduce((sum, o) => sum + o.totalAmount, 0),
  };
}

// A single read of store-products.json, grouped by store — callers pass the
// resulting map into getSellerCards/getStoresNeedingAttention instead of each
// re-reading the file per store. Carries the full product list (not just a
// count) so the sellers tab can also surface a per-product "block" toggle
// (see AdminSellersPanel.astro) without a second read.
export function getProductsByStoreMap(): Map<string, StoreProduct[]> {
  const map = new Map<string, StoreProduct[]>();
  for (const product of readProducts()) {
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
function attentionReasons(store: Store, productCount: number): string[] {
  const reasons: string[] = [];
  if (productCount === 0) reasons.push('0 מוצרים');
  if (!store.shipping) reasons.push('אין הגדרת משלוח');
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
}

// Flat, top-level "one row per store" view for the admin Stores tab — unlike
// getSellerCards (grouped per-seller, three levels deep with a nested
// accordion), this is a plain list an admin can scan/search across every
// store regardless of who owns it. Sorted by store name since that's what an
// admin searching for a specific store is scanning for, not seller identity.
export function getStoreRows(stores: Store[], sellers: Seller[], productsByStore: Map<string, StoreProduct[]>, revenueByStore: Map<string, StoreRevenue>): StoreRow[] {
  const sellerById = new Map(sellers.map((s) => [s.id, s]));
  return stores
    .map((store) => ({
      store,
      seller: sellerById.get(store.sellerId),
      productCount: productsByStore.get(store.id)?.length ?? 0,
      revenue: revenueByStore.get(store.slug) ?? EMPTY_REVENUE,
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
  blockedOnly: boolean;
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
    if (query.blockedOnly && !r.store.blocked) return false;
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

export function parseStoreQuery(sp: URLSearchParams): AdminStoreQuery {
  const requested = sp.get('stsort') ?? 'name:asc';
  const [sortCol, sortDir] = (VALID_STORE_SORT_COMBOS.has(requested) ? requested : 'name:asc').split(':') as [AdminStoreSortCol, AdminSortDir];
  return { q: (sp.get('stq') ?? '').trim(), sortCol, sortDir, blockedOnly: sp.get('stblocked') === '1' };
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
