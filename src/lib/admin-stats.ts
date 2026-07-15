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
export function filterSellerCards(cards: SellerCardData[], q: string): SellerCardData[] {
  const nq = normSearch(q);
  if (!nq) return cards;
  return cards.filter(({ seller, stores }) => {
    const hay = `${seller.name} ${seller.email} ${stores.map((s) => s.store.name).join(' ')}`.toLowerCase();
    return hay.includes(nq);
  });
}

export function filterStoreRows(rows: StoreRow[], q: string): StoreRow[] {
  const nq = normSearch(q);
  if (!nq) return rows;
  return rows.filter(({ store, seller }) => {
    const hay = `${store.name} ${store.slug} ${seller?.name ?? ''} ${seller?.email ?? ''}`.toLowerCase();
    return hay.includes(nq);
  });
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
