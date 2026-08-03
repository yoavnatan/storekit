import { firstRow } from './db.js';
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

/**
 * The four bottom stages as four counts, in one statement (§3, 2026-08-03).
 *
 * This used to read every seller, every store, every product and every order on the platform to
 * produce five integers. Each stage is a `COUNT(DISTINCT seller)` over an `EXISTS`, which is what
 * `buildSellerFunnel` above expresses as three `Set`s and a loop — kept, because it is the
 * definition this statement was written from and `tests/seller-funnel.test.ts` can drive it with
 * no database at all. `tests/reporting-invariants.test.ts` requires the two to agree.
 *
 * `deleted_at IS NULL` matches what `getAllStores` returns — a store the seller deleted never
 * counted toward "opened a store", and the JS this replaces was handed the same filtered list.
 */
export async function getSellerFunnel(): Promise<SellerFunnel> {
  const [counts, registerViews] = await Promise.all([
    firstRow<{ registered: string | number; with_store: string | number; with_product: string | number; with_sale: string | number }>(
      `SELECT
         (SELECT COUNT(*) FROM sellers) AS registered,
         COUNT(DISTINCT s.seller_id)                                            AS with_store,
         COUNT(DISTINCT s.seller_id) FILTER (WHERE EXISTS (
           SELECT 1 FROM store_products p WHERE p.store_id = s.id))             AS with_product,
         COUNT(DISTINCT s.seller_id) FILTER (WHERE EXISTS (
           SELECT 1 FROM order_items it WHERE it.store_slug = s.slug::text))     AS with_sale
       FROM stores s
      WHERE s.deleted_at IS NULL`,
    ),
    getLifetimeEventSessions('seller_register_view'),
  ]);
  return {
    registerViews,
    registered: Number(counts?.registered ?? 0),
    withStore: Number(counts?.with_store ?? 0),
    withProduct: Number(counts?.with_product ?? 0),
    withSale: Number(counts?.with_sale ?? 0),
  };
}
