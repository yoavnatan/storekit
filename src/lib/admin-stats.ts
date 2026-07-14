import type { Seller } from './seller-auth.js';
import type { Store } from './stores.js';
import type { Order } from './orders.js';
import { readProducts } from './store-products.js';

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
// re-reading the file per store.
export function getProductCountsByStore(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const product of readProducts()) {
    counts.set(product.storeId, (counts.get(product.storeId) ?? 0) + 1);
  }
  return counts;
}

export interface SellerCardData {
  seller: Seller;
  stores: Array<{ store: Store; productCount: number }>;
  totalProducts: number;
}

export function getSellerCards(sellers: Seller[], stores: Store[], productCounts: Map<string, number>): SellerCardData[] {
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
        productCount: productCounts.get(store.id) ?? 0,
      }));
      return {
        seller,
        stores: sellerStores,
        totalProducts: sellerStores.reduce((sum, s) => sum + s.productCount, 0),
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

export function getStoresNeedingAttention(stores: Store[], sellers: Seller[], productCounts: Map<string, number>): AttentionEntry[] {
  const sellerById = new Map(sellers.map((s) => [s.id, s]));
  return stores
    .map((store) => {
      const productCount = productCounts.get(store.id) ?? 0;
      const reasons = attentionReasons(store, productCount);
      if (reasons.length === 0) return null;
      return { store, seller: sellerById.get(store.sellerId), reasons };
    })
    .filter((entry): entry is AttentionEntry => entry !== null);
}
