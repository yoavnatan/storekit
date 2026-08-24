import { firstRow } from './db.js';
import { getLifetimeEventSessions } from './analytics.js';
import { PAYME_SUB_STATUS } from './payment-payme.js';

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
  /**
   * ── The four stages between a built shop and a selling one (2026-08-24) ──
   *
   * The funnel used to jump straight from "added a product" to "made a sale", which hid the whole
   * of the paying half — and that half is where a seller is most likely to stop. The owner asked
   * for the real funnel to be visible here (*"המשפך צריך להיות מיוצג גם בלשונית בדשבורד אדמין של
   * נתונים"*), and these are the four gates, in the order `store-publication.ts` puts them:
   *
   *   sentClearing  — sent PayMe what they need; a merchant account exists (his to do, minutes)
   *   approved      — PayMe approved the business (nobody's to do, up to seven business days)
   *   subscribed    — the standing order is running (his to do, one click and a card)
   *   live          — a shop of his is actually on the site
   *
   * Splitting `sentClearing` from `approved` is the point of having four rather than two: a drop
   * at the first is a form nobody finishes, a drop at the second is a wait people abandon, and the
   * fix for one is nothing like the fix for the other.
   */
  sentClearing: number;
  approved: number;
  subscribed: number;
  live: number;
  withSale: number;      // sellers with ≥1 store that has ≥1 order
}

// Minimal shapes so the pure builder is testable without the full domain types.
interface FSeller { id: string }
interface FStore { id: string; sellerId: string; slug: string; publishedAt?: string }
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
  /** The money half, per seller id — `sentClearing` implies nothing about the other two, which is
   *  why they are three sets rather than a state. A seller can be approved and not subscribed, and
   *  (mid-dunning) subscribed and not approved. */
  money: { sentClearing?: Set<string>; approved?: Set<string>; subscribed?: Set<string> } = {},
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
  let sentClearing = 0;
  let approved = 0;
  let subscribed = 0;
  let live = 0;
  let withSale = 0;
  for (const seller of sellers) {
    const own = storesBySeller.get(seller.id) ?? [];
    if (own.length === 0) continue;
    withStore += 1;
    if (own.some((st) => storeIdsWithProduct.has(st.id))) withProduct += 1;
    // The three money gates are asked of the SELLER (one clearing account and one standing order
    // per registered business), and "live" is asked of his shops — because a shop is what goes on
    // the site, and a seller counts here the moment any one of them does.
    if (money.sentClearing?.has(seller.id)) sentClearing += 1;
    if (money.approved?.has(seller.id)) approved += 1;
    if (money.subscribed?.has(seller.id)) subscribed += 1;
    if (own.some((st) => !!st.publishedAt)) live += 1;
    if (own.some((st) => soldStoreSlugs.has(st.slug))) withSale += 1;
  }

  return { registerViews, registered: sellers.length, withStore, withProduct, sentClearing, approved, subscribed, live, withSale };
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
    firstRow<Record<string, string | number>>(
      `SELECT
         (SELECT COUNT(*) FROM sellers) AS registered,
         COUNT(DISTINCT s.seller_id)                                            AS with_store,
         COUNT(DISTINCT s.seller_id) FILTER (WHERE EXISTS (
           SELECT 1 FROM store_products p WHERE p.store_id = s.id))             AS with_product,
         -- The four money gates, in the order store-publication.ts puts them. Each is an EXISTS
         -- over the seller, so a seller with three shops counts once — the clearing account and
         -- the standing order are per registered business, not per shop.
         COUNT(DISTINCT s.seller_id) FILTER (WHERE EXISTS (
           SELECT 1 FROM seller_merchant_accounts m WHERE m.seller_id = s.seller_id))
                                                                                AS sent_clearing,
         COUNT(DISTINCT s.seller_id) FILTER (WHERE EXISTS (
           SELECT 1 FROM seller_merchant_accounts m
            WHERE m.seller_id = s.seller_id AND m.approved))                    AS approved,
         COUNT(DISTINCT s.seller_id) FILTER (WHERE EXISTS (
           SELECT 1 FROM seller_subscriptions sub
            WHERE sub.seller_id = s.seller_id AND sub.status = ANY($1::int[]))) AS subscribed,
         COUNT(DISTINCT s.seller_id) FILTER (WHERE s.published_at IS NOT NULL)  AS live,
         COUNT(DISTINCT s.seller_id) FILTER (WHERE EXISTS (
           SELECT 1 FROM order_items it WHERE it.store_slug = s.slug::text))    AS with_sale
       FROM stores s
      WHERE s.deleted_at IS NULL`,
      // PayMe's own integers, from the ONE module that interprets them — never literals here, or
      // this becomes a second definition of "paying" that can drift from the publication gate.
      [[PAYME_SUB_STATUS.active, PAYME_SUB_STATUS.retrying]],
    ),
    getLifetimeEventSessions('seller_register_view'),
  ]);
  const n = (key: string): number => Number(counts?.[key] ?? 0);
  return {
    registerViews,
    registered: n('registered'),
    withStore: n('with_store'),
    withProduct: n('with_product'),
    sentClearing: n('sent_clearing'),
    approved: n('approved'),
    subscribed: n('subscribed'),
    live: n('live'),
    withSale: n('with_sale'),
  };
}
