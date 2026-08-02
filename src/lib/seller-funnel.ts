import { getAllSellers } from './seller-auth.js';
import { getAllStores } from './stores.js';
import { readProducts } from './store-products.js';
import { getAllOrders } from './orders.js';
import { getLifetimeEventSessions } from './analytics.js';

// The SELLER onboarding funnel — a lifetime, cumulative snapshot (NOT windowed
// by a date range) answering "of everyone who set out to open a store, where do
// they get stuck?". Cumulative is the right lens here: a seller who registered
// last month but only added a product today should still count once at each
// stage they've reached, not be split across range buckets. The four bottom
// stages are derived entirely from existing records (no new event storage); only
// the top stage ("visited the register page") needs a captured pageview.
export interface SellerFunnel {
  registerViews: number; // distinct sessions that opened /seller/register
  registered: number;    // seller accounts created
  withStore: number;     // sellers who created ≥1 store
  withProduct: number;   // sellers with ≥1 store that has ≥1 product
  withSale: number;      // sellers with ≥1 store that has ≥1 order
}

// Minimal shapes so the pure builder is testable without the full domain types.
interface FSeller { id: string }
interface FStore { id: string; sellerId: string; slug: string }
interface FProduct { storeId: string }
interface FOrderItem { storeSlug: string }
interface FOrder { items: FOrderItem[] }

/** Pure — count how many sellers reached each onboarding stage. */
export function buildSellerFunnel(
  sellers: FSeller[],
  stores: FStore[],
  products: FProduct[],
  orders: FOrder[],
  registerViews: number,
): SellerFunnel {
  const storesBySeller = new Map<string, FStore[]>();
  for (const s of stores) {
    const list = storesBySeller.get(s.sellerId) ?? [];
    list.push(s);
    storesBySeller.set(s.sellerId, list);
  }
  const storeIdsWithProduct = new Set(products.map((p) => p.storeId));
  const soldStoreSlugs = new Set(orders.flatMap((o) => o.items.map((i) => i.storeSlug)));

  let withStore = 0;
  let withProduct = 0;
  let withSale = 0;
  for (const seller of sellers) {
    const own = storesBySeller.get(seller.id) ?? [];
    if (own.length === 0) continue;
    withStore += 1;
    if (own.some((st) => storeIdsWithProduct.has(st.id))) withProduct += 1;
    if (own.some((st) => soldStoreSlugs.has(st.slug))) withSale += 1;
  }

  return { registerViews, registered: sellers.length, withStore, withProduct, withSale };
}

/** I/O wrapper — pulls the current records + lifetime register-page views. */
export async function getSellerFunnel(): Promise<SellerFunnel> {
  return buildSellerFunnel(
    await getAllSellers(),
    getAllStores(),
    readProducts(),
    getAllOrders(),
    getLifetimeEventSessions('seller_register_view'),
  );
}
