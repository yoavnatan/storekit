/**
 * Orders — the fifth module moved off `data/*.json` (DB_MIGRATION_PLAN.md §8 stage 2), and the one
 * that carries the money. Every reader and writer is a query, so all of them are `async` and every
 * caller `await`s (§3).
 *
 * Three things changed beyond "the file became a table":
 *
 *   · **The unit flipped, and the FIELDS WERE RENAMED so the compiler could find every call site.**
 *     §7.7 has always said money is stored as integer agorot; `store-products` converted at its own
 *     edge and left the rest of the app in ILS, deliberately, because flipping the unit is a change
 *     to make once. This is that once. Every money field on an order now ends in `Agorot` and holds
 *     an integer — `totalAgorot`, `shippingAgorot`, `priceAgorot`, `subtotalAgorot`, `appliedAgorot`.
 *     The rename is the entire safety mechanism: a unit change under an unchanged name is a silent
 *     100× error that `number → number` type-checks perfectly, and there is no test that would
 *     reliably catch every missed reader. Renaming turns all of them into build errors.
 *
 *     The line the unit stops at is RENDER AND INPUT. `formatPrice` still takes ILS, the seller's
 *     discount form still sends and redisplays the number they typed, and `discount.value` is
 *     therefore still percent-points or ILS exactly as before — it is what the form round-trips,
 *     not a number this module sums. `appliedAgorot`, beside it, is the money.
 *
 *   · **`getAllOrders()` is no longer how you find a buyer's orders.** Three surfaces (the buyer
 *     dashboard, its API, and the homepage's "stores you bought from") read every order on the
 *     platform into memory and filtered it down to one person's. `getOrdersByBuyer` is that filter
 *     as a WHERE, and `getPurchasedCountsByStoreSlugs` / `getStoreSlugsWithPendingOrders` are the
 *     batched forms of two reads that sat inside a per-store loop — the feed builder and the
 *     seller's alert dots, one query per store each (§8's N+1 note, now measured against a pool
 *     of 10 connections rather than a filesystem cache).
 *
 *   · **The item ORDER is a column now (migration 0004).** The lines were an array and arrays are
 *     ordered; rows are not. See the migration for why every alternative sort key is wrong.
 *
 *   · **`getAllOrders()` is gone (§3, 2026-08-03).** Its three remaining callers all aggregated
 *     over the whole platform, and that work moved into the database in one piece:
 *     `order-reporting.ts` holds every whole-platform `SUM`/`GROUP BY`, and `getAdminOrdersPage`
 *     below is the admin Orders tab's own page — a `WHERE`, an `ORDER BY` and a `LIMIT`, where an
 *     array of every order the platform has ever taken used to be filtered and sliced to fifteen
 *     rows. The pure `filterAndSortOrders` beside it stays as that query's unit-testable twin
 *     (`admin-orders-filter.ts`), the same arrangement `purchasedCountsFrom` and
 *     `selectMoneyEvents` already have with their queries.
 */
import crypto from 'node:crypto';
import type { DeliveryMethod } from './shipping.js';
import {
  orderCountsAsRevenue,
  REVENUE_PAYMENT_STATUSES,
  REVENUE_SHIPPING_STATUSES,
} from './order-status-rules.js';
import { sanitizeAttribution, type OrderAttribution } from './attribution.js';
import { firstRow, isUuid, rows, withTransaction, type Queryable } from './db.js';
import { SHIPPING_SORT_ORDER, type AdminOrderQuery } from './admin-orders-filter.js';
import { CHECKOUT_GROUP_KEY_SQL } from './checkout-group.js';

export interface OrderItem {
  productId: string;
  productName: string;
  productSlug: string;
  storeSlug: string;
  storeName: string;
  /** Unit price at the moment of purchase, in integer agorot. A SNAPSHOT — `order_items` has no
   *  foreign key to the product on purpose (§4), because pointing a sold line at the live product
   *  would let tomorrow's price edit rewrite yesterday's receipt. */
  priceAgorot: number;
  qty: number;
  image?: string;
  selectedVariants?: Record<string, string>;
}

export interface StoreSubtotal {
  storeName: string;
  subtotalAgorot: number;
  shippingAgorot: number;
  /** Delivery method the buyer chose for this store — so the seller knows to prepare it
   *  for pickup vs ship it. Set from the validated method at checkout. Optional for
   *  backward-compat with orders placed before delivery methods existed. */
  deliveryMethod?: DeliveryMethod;
  /** `value` is what the seller TYPED and what their edit form shows back: percent-points for
   *  `percent`, ILS for `amount`. `appliedAgorot` is the money it came to, and is the only one of
   *  the two any total is built from. They are stored in separate columns for the same reason. */
  discount?: { type: 'percent' | 'amount'; value: number; appliedAgorot: number };
  /** The coupon code that WROTE the discount above, when a buyer's code is what produced it rather
   *  than the seller editing the order afterwards. Provenance only — no total is built from it, and
   *  a coupon and a seller discount are deliberately not two slots (migrations/0020's header says
   *  why: one order-level discount column is what makes a coupon correct in every money surface on
   *  day one). It follows that a seller who later edits the discount on such an order REPLACES the
   *  coupon's number, and the code is cleared with it — the alternative is a receipt naming a code
   *  beside an amount that code never gave. */
  couponCode?: string;
}

export interface Order {
  id: string;
  checkoutRef?: string;
  buyerId?: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  buyerAddress: {
    city: string;
    street: string;
    zip?: string;
  };
  items: OrderItem[];
  storeSubtotals: Record<string, StoreSubtotal>;
  shippingAgorot: number;
  totalAgorot: number;
  paymentRef?: string;
  paymentStatus: 'pending' | 'paid' | 'failed';
  shippingStatus: 'pending' | 'processing' | 'ready' | 'shipped' | 'delivered' | 'cancelled';
  trackingNumber?: string;
  /** Private seller-only handling notes, keyed by storeSlug so each seller's notes on a
   *  (possibly multi-store) order stay private from the other stores' sellers. A LIST per
   *  store (a seller can jot several notes). Never exposed to the buyer or leaked
   *  cross-store: /api/seller/orders returns only the requesting store's own list as a
   *  scoped `notes` array, never this whole map. Legacy data may hold a single string per
   *  store — read it through orderStoreNotes(), which coerces string → one-item list. */
  sellerNotes?: Record<string, string[]>;
  /** The ad click this purchase came from, if any — click id and/or UTM tags plus the moment the
   *  visitor landed (`lib/attribution.ts`, migration 0010). A SNAPSHOT like every other field here:
   *  it records what the cookie said at the moment of purchase, and `updateOrder` cannot touch it.
   *  Absent on an organic order, which is most of them.
   *
   *  **Platform-internal — never sent to a seller or a buyer** (`tests/order-client-projection.ts`
   *  enforces it). The platform advertises out of one Google account and one Meta pixel for every
   *  store, so the campaign names in here are the OWNER's marketing structure and not the seller's
   *  data. */
  attribution?: OrderAttribution;
  createdAt: string;
  updatedAt: string;
}

/**
 * Does this order count toward money actually earned?
 *
 * THE one predicate for revenue/GMV — seller performance and the admin platform
 * stats both go through it, because they drifted apart exactly once and the
 * result was money reported that no longer existed.
 *
 * `paymentStatus === 'paid'` alone is not the question. A cancellation
 * deliberately leaves `paymentStatus` at 'paid' (the charge really did happen;
 * the refund is a separate event) and moves `shippingStatus` to 'cancelled',
 * restocking the items. So a cancelled order stayed inside every revenue sum:
 * the seller's Performance tab and the admin's GMV/commission split would both
 * keep reporting a sale whose stock had already gone back on the shelf. Nobody
 * had cancelled a paid order yet in the data, which is the only reason it hadn't
 * surfaced — it was waiting for the first real one.
 *
 * If a partial-refund state is ever added, it belongs here too, not at a call site.
 *
 * The rule itself now lives in order-status-rules.ts, as one row per status in a
 * table with a column per consequence — so a new status cannot be added without
 * answering "does this count as revenue?" alongside every other question it raises.
 * This stays the name the rest of the codebase calls.
 */
export function countsAsRevenue(o: Pick<Order, 'paymentStatus' | 'shippingStatus'>): boolean {
  return orderCountsAsRevenue(o);
}

/** This store's private notes on an order as a list, coercing legacy single-string data. */
export function orderStoreNotes(o: Order, storeSlug: string): string[] {
  const v = o.sellerNotes?.[storeSlug] as unknown;
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
  if (typeof v === 'string' && v.trim() !== '') return [v];
  return [];
}

export type CreateOrderInput = Omit<Order, 'id' | 'shippingStatus' | 'createdAt' | 'updatedAt'>;

// ── rows → Order ────────────────────────────────────────────────────────────

interface ItemRow {
  product_id: string | null;
  product_name: string;
  product_slug: string;
  store_slug: string;
  store_name: string;
  price_agorot: string | number;
  qty: number;
  image: string | null;
  selected_variants: Record<string, string> | null;
}

interface StoreRow {
  store_slug: string;
  store_name: string;
  subtotal_agorot: string | number;
  shipping_agorot: string | number;
  delivery_method: DeliveryMethod | null;
  discount_type: 'percent' | 'amount' | null;
  discount_percent: number | null;
  discount_amount_agorot: string | number | null;
  discount_applied_agorot: string | number;
  coupon_code: string | null;
  seller_notes: string[] | null;
}

interface OrderRow {
  id: string;
  checkout_ref: string | null;
  buyer_id: string | null;
  buyer_name: string;
  buyer_email: string;
  buyer_phone: string;
  buyer_city: string;
  buyer_street: string;
  buyer_zip: string | null;
  shipping_agorot: string | number;
  total_agorot: string | number;
  payment_ref: string | null;
  payment_status: Order['paymentStatus'];
  shipping_status: Order['shippingStatus'];
  tracking_number: string | null;
  /** `jsonb`, so the driver hands back a parsed object. Typed `unknown` on purpose: it is
   *  re-validated through `attribution.ts` on the way out rather than trusted for having been in
   *  our own column, which also means a row written by an older or hand-edited shape degrades to
   *  "no attribution" instead of putting a malformed record on an order. */
  attribution: unknown;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  items: ItemRow[] | null;
  stores: StoreRow[] | null;
}

/**
 * `bigint` arrives from `pg` as a STRING, and from PGlite as a number.
 *
 * The driver is right to do it — a 64-bit integer does not fit a JS number — but every amount this
 * app holds is agorot in the millions at most, so the value is exact either way and the only real
 * hazard is the type. Untouched, `'1250' + 500` is `'1250500'`: string concatenation, no error, a
 * total off by four orders of magnitude on the one screen where that matters. Every read of a
 * `*_agorot` column goes through this.
 */
function bigIntOf(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isoOf(v: Date | string | null): string {
  if (v instanceof Date) return v.toISOString();
  return v ? new Date(v).toISOString() : '';
}

function toItem(row: ItemRow): OrderItem {
  const item: OrderItem = {
    // A line whose product has since been deleted keeps its snapshot and loses only the link
    // (`product_id` is nullable and unenforced by design). '' is what the file held for those.
    productId: row.product_id ?? '',
    productName: row.product_name,
    productSlug: row.product_slug,
    storeSlug: row.store_slug,
    storeName: row.store_name,
    priceAgorot: bigIntOf(row.price_agorot),
    qty: row.qty,
  };
  if (row.image) item.image = row.image;
  if (row.selected_variants && Object.keys(row.selected_variants).length) {
    item.selectedVariants = row.selected_variants;
  }
  return item;
}

function toStoreSubtotal(row: StoreRow): StoreSubtotal {
  const sub: StoreSubtotal = {
    storeName: row.store_name,
    subtotalAgorot: bigIntOf(row.subtotal_agorot),
    shippingAgorot: bigIntOf(row.shipping_agorot),
  };
  if (row.delivery_method) sub.deliveryMethod = row.delivery_method;
  if (row.discount_type) {
    // Rebuilt in the shape the seller's edit form round-trips: `value` in the unit they typed,
    // `appliedAgorot` as the money. See the StoreSubtotal doc comment.
    const value = row.discount_type === 'percent'
      ? (row.discount_percent ?? 0)
      : bigIntOf(row.discount_amount_agorot) / 100;
    sub.discount = { type: row.discount_type, value, appliedAgorot: bigIntOf(row.discount_applied_agorot) };
  }
  // Only alongside a discount it can explain. A stored code with no discount left beside it would
  // print "קופון: X" on a receipt showing nothing taken off.
  if (row.coupon_code && sub.discount) sub.couponCode = row.coupon_code;
  return sub;
}

/**
 * Row → `Order`, in the exact shape the rest of the app reads — optional keys ABSENT rather than
 * `null`, because that is what the file held and what every `o.checkoutRef ?? …` call site is
 * written against.
 */
function toOrder(row: OrderRow): Order {
  const order: Order = {
    id: row.id,
    buyerName: row.buyer_name,
    buyerEmail: row.buyer_email,
    buyerPhone: row.buyer_phone,
    buyerAddress: {
      city: row.buyer_city,
      street: row.buyer_street,
      ...(row.buyer_zip ? { zip: row.buyer_zip } : {}),
    },
    items: (row.items ?? []).map(toItem),
    storeSubtotals: {},
    shippingAgorot: bigIntOf(row.shipping_agorot),
    totalAgorot: bigIntOf(row.total_agorot),
    paymentStatus: row.payment_status,
    shippingStatus: row.shipping_status,
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
  if (row.checkout_ref) order.checkoutRef = row.checkout_ref;
  if (row.buyer_id) order.buyerId = row.buyer_id;
  if (row.payment_ref) order.paymentRef = row.payment_ref;
  if (row.tracking_number) order.trackingNumber = row.tracking_number;
  // Through the sanitiser, not straight off the column — see its doc for why our own `jsonb` is
  // still re-validated, and why NO lookback window is applied on the way out.
  const attribution = sanitizeAttribution(row.attribution);
  if (attribution) order.attribution = attribution;

  const sellerNotes: Record<string, string[]> = {};
  for (const s of row.stores ?? []) {
    order.storeSubtotals[s.store_slug] = toStoreSubtotal(s);
    if (s.seller_notes?.length) sellerNotes[s.store_slug] = s.seller_notes;
  }
  if (Object.keys(sellerNotes).length) order.sellerNotes = sellerNotes;
  return order;
}

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * One order, its lines and its per-store slices, in one round trip.
 *
 * The two `jsonb_agg`s are lateral rather than a plain join because a join across both children
 * multiplies them — three lines and two stores come back as six rows, and the subtotals would be
 * counted three times each by anything that summed them. `ORDER BY` inside each agg is what makes
 * the sequence a fact rather than whatever the plan happened to produce (§7.13): lines by their
 * array index (migration 0004), stores by slug.
 */
const SELECT_ORDERS = `
  SELECT o.id, o.checkout_ref, o.buyer_id, o.buyer_name, o.buyer_email, o.buyer_phone,
         o.buyer_city, o.buyer_street, o.buyer_zip, o.shipping_agorot, o.total_agorot,
         o.payment_ref, o.payment_status, o.shipping_status, o.tracking_number,
         o.attribution, o.created_at, o.updated_at,
         i.items, s.stores
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(to_jsonb(it) ORDER BY it.position, it.id) AS items
        FROM order_items it WHERE it.order_id = o.id
    ) i ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(to_jsonb(os) ORDER BY os.store_slug) AS stores
        FROM order_stores os WHERE os.order_id = o.id
    ) s ON true`;

/** Newest first, with `id` breaking the tie — two orders written in the same transaction share a
 *  `created_at` to the microsecond, and without the tie-break they swap places between loads. */
const ORDER = 'ORDER BY o.created_at DESC, o.id';

async function selectOrders(where: string, params: readonly unknown[] = [], tx?: Queryable): Promise<Order[]> {
  const text = `${SELECT_ORDERS} WHERE ${where} ${ORDER}`;
  const result = tx ? (await tx.query<OrderRow>(text, params)).rows : await rows<OrderRow>(text, params);
  return result.map(toOrder);
}

export async function getOrderById(id: string): Promise<Order | null> {
  // Postgres REJECTS a malformed uuid literal rather than simply not matching it, so an order id
  // out of a stale link would be a 500 on a page whose honest answer is "not found".
  if (!isUuid(id)) return null;
  const row = await firstRow<OrderRow>(`${SELECT_ORDERS} WHERE o.id = $1`, [id]);
  return row ? toOrder(row) : null;
}

/**
 * ONE page of the admin Orders tab — the whole toolbar pushed into the query (§3, 2026-08-03).
 *
 * What this replaced: `getAllOrders()` into memory, `filterAndSortOrders` over the array, then
 * `paginate()` down to fifteen rows. Every order the platform has ever taken, to render a screen
 * that shows fifteen of them.
 *
 * **The pure twin is `admin-orders-filter.ts#filterAndSortOrders`, and it is deliberately still
 * there.** It is what makes the search/sort/filter rules testable without a database, and
 * `tests/admin-orders-page.test.ts` runs both over the same rows and requires the same answer —
 * so a predicate that drifts fails a test instead of quietly showing an admin a different list.
 *
 * One difference is real and is not a drift: the free-text haystack joins this order's store names
 * in ALPHABETICAL order here and in first-appearance order in JS. It only shows for a query string
 * that spans two store names across the join, and neither order is more correct than the other.
 */
export interface AdminOrdersPage {
  orders: Order[];
  /** Rows matching the filters, before the page slice — what the pager counts. */
  total: number;
  /** Orders on the platform, ignoring every filter. The panel needs both to tell "no orders yet"
   *  from "no orders match what you typed", and those are different screens. It cannot be
   *  `orders.length` any more, which is exactly the kind of number a page slice silently breaks. */
  totalUnfiltered: number;
  page: number;
  totalPages: number;
}

export async function getAdminOrdersPage(
  query: AdminOrderQuery & { newSince?: string },
  page: number,
  pageSize: number,
): Promise<AdminOrdersPage> {
  const q = query.q?.trim().toLowerCase() || null;
  // Exactly the five the predicate names. A parameter a statement does not reference is a bind
  // error, not a spare — which is why the sort order and the page bounds are appended per query
  // rather than carried in one list.
  const params = [
    query.shippingStatus?.length ? query.shippingStatus : null,
    query.paymentStatus?.length ? query.paymentStatus : null,
    query.store?.length ? query.store : null,
    q,
    query.newSince ?? null,
  ];
  // The haystack `orderSearchHaystack` builds, as one expression. `position(… in …) > 0` is
  // `String.includes`, and both sides are lowercased exactly as the JS is.
  const HAYSTACK = `lower(
      o.id::text || ' ' || COALESCE(o.checkout_ref, '') || ' ' || o.buyer_name || ' ' ||
      o.buyer_email || ' ' || o.buyer_phone || ' ' ||
      COALESCE((SELECT string_agg(DISTINCT it.store_name, ' ') FROM order_items it WHERE it.order_id = o.id), '')
    )`;
  const where = `
       ($1::text[] IS NULL OR o.shipping_status = ANY($1::text[]))
   AND ($2::text[] IS NULL OR o.payment_status  = ANY($2::text[]))
   AND ($3::text[] IS NULL OR EXISTS (
         SELECT 1 FROM order_items it WHERE it.order_id = o.id AND it.store_name = ANY($3::text[])))
   AND ($4::text   IS NULL OR position($4::text in ${HAYSTACK}) > 0)
   AND ($5::text   IS NULL OR o.created_at > $5::timestamptz)`;

  // ── The page is a page of PURCHASES, not of order rows (owner, 2026-08-07) ──
  //
  // A cart spanning five stores is five rows in `orders`, and this tab used to show it as five
  // separate orders — five cards, five "order numbers", five totals for one thing the buyer bought
  // once. Everything below therefore counts, sorts and slices by `checkout-group.ts`'s key, and
  // only then fetches rows.
  //
  // The consequence that matters for correctness: a group is selected by whether ANY of its rows
  // matches the filter, and then ALL of its rows are returned. Filtering the rows themselves would
  // hand the card a partial purchase — "shipping status = חדשה" on a five-store order would draw a
  // card whose total is the sum of two slices, which is a wrong number rather than a narrow one.
  const byStatus = query.sortCol === 'shippingStatus';
  // The fulfilment order is handed over as DATA. A `CASE WHEN 'pending' THEN 0 …` written here
  // would be a second copy of the status table, in a language `tests/money-guards.test.ts` cannot
  // read — which is exactly what that guard exists to stop.
  const rankAt = params.length + 1;
  const keyedParams = [...params, SHIPPING_SORT_ORDER];
  // Each aggregate answers for the WHOLE purchase, which is what the card shows: its date is when
  // the checkout happened, its amount is what the buyer paid altogether, and its status is the
  // least-advanced slice — the same headline rule `buyer-purchases.ts` renders by, because an
  // order with one store delivered and four still pending is a pending order.
  const KEYED = `
    WITH keyed AS (
      SELECT ${CHECKOUT_GROUP_KEY_SQL} AS gkey,
             o.created_at, o.total_agorot,
             COALESCE(array_position($${rankAt}::text[], o.shipping_status), 99) AS status_rank,
             (${where}) AS matches
        FROM orders o
    ),
    grouped AS (
      SELECT gkey,
             MIN(created_at)  AS created_at,
             SUM(total_agorot) AS total_agorot,
             MIN(status_rank) AS status_rank,
             BOOL_OR(matches) AS matched
        FROM keyed GROUP BY gkey
    )`;

  const sortKey = query.sortCol === 'amount' ? 'total_agorot'
    : byStatus ? 'status_rank'
    : 'created_at';
  const dir = query.sortDir === 'asc' ? 'ASC' : 'DESC';

  const counts = await firstRow<{ matched: string | number; every: string | number }>(
    `${KEYED} SELECT COUNT(*) FILTER (WHERE matched) AS matched, COUNT(*) AS every FROM grouped`,
    keyedParams,
  );
  const total = bigIntOf(counts?.matched);
  const totalUnfiltered = bigIntOf(counts?.every);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const limitAt = keyedParams.length + 1;
  // `gkey` last in the ORDER BY for the same reason `o.id` was: the slices of one checkout share a
  // `created_at` to the microsecond, so without a total tie-break two purchases swap places between
  // loads and page 2 silently repeats or skips one.
  const keys = await rows<{ gkey: string }>(
    `${KEYED}
     SELECT gkey FROM grouped WHERE matched
      ORDER BY ${sortKey} ${dir}, created_at DESC, gkey
      LIMIT $${limitAt} OFFSET $${limitAt + 1}`,
    [...keyedParams, pageSize, (safePage - 1) * pageSize],
  );
  if (keys.length === 0) return { orders: [], total, totalUnfiltered, page: safePage, totalPages };

  // Every row of the chosen purchases, in the same group order the page was built in — the caller
  // groups them back with `checkoutGroupKey` and must not have to re-sort to get the page right.
  const found = await rows<OrderRow>(
    `${SELECT_ORDERS} WHERE ${CHECKOUT_GROUP_KEY_SQL} = ANY($1::text[])
      ORDER BY array_position($1::text[], ${CHECKOUT_GROUP_KEY_SQL}), o.created_at, o.id`,
    [keys.map((k) => k.gkey)],
  );
  return { orders: found.map(toOrder), total, totalUnfiltered, page: safePage, totalPages };
}

/** Is this order one of `storeSlug`'s to see and to manage?
 *
 *  **Every by-id order mutation must go through this.** A seller session proves which STORES the
 *  seller owns — it says nothing about which ORDERS, and an order id is not a permission. Without
 *  this bind, `PATCH /api/seller/orders` accepted any orderId as long as the *slug* alongside it was
 *  the caller's own, which let one seller move another seller's order to 'cancelled' (restocking
 *  that seller's inventory and mailing their buyer), rewrite the buyer's name/address, or delete
 *  items and recompute the total. Fixed 2026-08-02; `tests/seller-orders-scope.test.ts` keeps it.
 *
 *  The `storeSubtotals` key is checked as well as the items: a seller who deletes the last item of
 *  their own order must not lock themselves out of it — the subtotal key survives that edit.
 *
 *  Pure, and stays pure — it is the predicate the by-slug queries below are written FROM, and both
 *  halves of its OR are in them for the same reason they are here. */
export function orderBelongsToStore(order: Pick<Order, 'items' | 'storeSubtotals'>, storeSlug: string): boolean {
  if (!storeSlug) return false;
  return order.items.some((i) => i.storeSlug === storeSlug)
    || (order.storeSubtotals ?? {})[storeSlug] !== undefined;
}

/** The SQL half of `orderBelongsToStore`, over a list of slugs. Both `EXISTS` legs are present
 *  because the predicate has both: the two sides agree on all 207 orders measured today, but they
 *  are written by two separate statements and the check that guards a seller's access to an order
 *  is the wrong place to start trusting that they always will. */
const BELONGS_TO_SLUGS = `(
     EXISTS (SELECT 1 FROM order_items  it WHERE it.order_id = o.id AND it.store_slug = ANY($1::text[]))
  OR EXISTS (SELECT 1 FROM order_stores os WHERE os.order_id = o.id AND os.store_slug = ANY($1::text[]))
)`;

export async function getOrdersByStoreSlug(storeSlug: string): Promise<Order[]> {
  if (!storeSlug) return [];
  return selectOrders(BELONGS_TO_SLUGS, [[storeSlug]]);
}

export async function getOrdersBySellerStores(storeSlugs: string[]): Promise<Order[]> {
  const slugs = storeSlugs.filter(Boolean);
  if (!slugs.length) return [];
  return selectOrders(BELONGS_TO_SLUGS, [slugs]);
}

/**
 * This buyer's orders, newest first.
 *
 * Matched on the account id OR the email, which is not redundancy: accounts are unified
 * seller+buyer, and a guest can check out with an address they only later register with — so an
 * order placed before signup has no `buyer_id` and is reachable only by email. Three call sites
 * did exactly this filter over `getAllOrders()`, which is the whole platform's order history in
 * memory to render one person's page.
 */
export async function getOrdersByBuyer(buyerId: string | undefined, buyerEmail: string | undefined): Promise<Order[]> {
  const id = buyerId && isUuid(buyerId) ? buyerId : null;
  const email = buyerEmail?.trim() || null;
  if (!id && !email) return [];
  return selectOrders(
    '($1::uuid IS NOT NULL AND o.buyer_id = $1::uuid) OR ($2::citext IS NOT NULL AND o.buyer_email = $2::citext)',
    [id, email],
  );
}

// productId → units actually SOLD (countsAsRevenue orders only — see the note
// inside). A "how popular is this product" signal for the seller, not a
// fulfillment one, but popularity measured on sales that stuck.
/** Pure half of `getPurchasedCountsByStoreSlug` — takes the orders instead of
 *  reading them, matching how seller-performance.ts / admin-stats.ts are built
 *  (pure, pre-fetched data). Exported so units can be tested on a real mixed
 *  order list without mocking the data source. */
export function purchasedCountsFrom(orders: Order[], storeSlug: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of orders) {
    // "Units sold" means sold: same rule as revenue, for the same reason. This
    // counted EVERY order — payment pending, payment failed, and cancelled
    // (already restocked) alike — and it is not just a dashboard column. It also
    // feeds the public storefront's popularity ordering AND `custom_label_1` in
    // the Merchant/Meta feed (product-labels.ts → performanceTier), where a
    // product inflated to "bestseller" by failed and cancelled orders pulls real
    // campaign budget toward itself.
    if (!countsAsRevenue(o)) continue;
    for (const item of o.items) {
      if (item.storeSlug !== storeSlug) continue;
      counts[item.productId] = (counts[item.productId] ?? 0) + item.qty;
    }
  }
  return counts;
}

/**
 * Units sold per product, for MANY stores in one query.
 *
 * The per-store form below is this with a one-slug list, and it exists in this shape because its
 * heaviest caller is a loop: `/api/feed/products.xml` walks every indexable store, and one read per
 * store was free against a cached file and is one round trip per store against a pool of ten
 * connections (§8's note from `store-categories`, the same shape one module later).
 *
 * The revenue rule is applied in SQL here and by `purchasedCountsFrom` in JS, and the two must keep
 * answering the same question — so neither of them spells it out. Both read `order-status-rules.ts`:
 * the pure one calls `countsAsRevenue`, this one passes the same table's two columns in as lists.
 */
export async function getPurchasedCountsByStoreSlugs(storeSlugs: string[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  const slugs = storeSlugs.filter(Boolean);
  if (!slugs.length) return out;
  for (const slug of slugs) out.set(slug, {});

  const counted = await rows<{ store_slug: string; product_id: string | null; units: string | number }>(
    `SELECT it.store_slug, it.product_id, SUM(it.qty)::bigint AS units
       FROM order_items it
       JOIN orders o ON o.id = it.order_id
      WHERE it.store_slug = ANY($1::text[])
        AND o.payment_status = ANY($2::text[])
        AND o.shipping_status = ANY($3::text[])
      GROUP BY it.store_slug, it.product_id`,
    [slugs, REVENUE_PAYMENT_STATUSES, REVENUE_SHIPPING_STATUSES],
  );
  for (const row of counted) {
    // A line whose product was deleted keeps '' as its id, exactly as `toItem` reads it.
    const bucket = out.get(row.store_slug);
    if (bucket) bucket[row.product_id ?? ''] = bigIntOf(row.units);
  }
  return out;
}

export async function getPurchasedCountsByStoreSlug(storeSlug: string): Promise<Record<string, number>> {
  return (await getPurchasedCountsByStoreSlugs([storeSlug])).get(storeSlug) ?? {};
}

/**
 * Which of these stores have at least one order awaiting the seller's first touch.
 *
 * The alert dot beside a seller's store, and the reason it is a set rather than a boolean per
 * store: `seller-alerts.ts` asked this once per store inside a loop, which a file read absorbed
 * and a query does not. One statement, one row per store that has one.
 */
export async function getStoreSlugsWithPendingOrders(storeSlugs: string[]): Promise<Set<string>> {
  const slugs = storeSlugs.filter(Boolean);
  if (!slugs.length) return new Set();
  const found = await rows<{ store_slug: string }>(
    `SELECT DISTINCT os.store_slug
       FROM order_stores os
       JOIN orders o ON o.id = os.order_id
      WHERE os.store_slug = ANY($1::text[]) AND o.shipping_status = 'pending'`,
    [slugs],
  );
  return new Set(found.map((r) => r.store_slug));
}

// ── writes ──────────────────────────────────────────────────────────────────

/** Both money and quantity are constrained non-negative in the schema, and a caller that passed a
 *  negative used to have it stored rather than raised. Clamping keeps that answer: a bad number
 *  stays a bad number instead of becoming a 500 on a checkout that worked yesterday (§7 trap —
 *  a CHECK turns what the file kept quietly into an error). `reconcile.ts` is what reports the
 *  nonsense; a write path is not the place to discover it. */
const nonNegative = (n: unknown): number => Math.max(0, Math.round(Number(n) || 0));

/** `qty > 0` in the schema, and a zero-quantity line is not a line — it is a deleted one that
 *  someone forgot to remove. One is the floor the importer already applies to legacy rows. */
const qtyOf = (n: unknown): number => Math.max(1, Math.round(Number(n) || 0));

async function writeItems(tx: Queryable, orderId: string, items: OrderItem[]): Promise<void> {
  if (!items.length) return;
  await tx.query(
    `INSERT INTO order_items (id, order_id, product_id, product_name, product_slug, store_slug,
                              store_name, price_agorot, qty, image, selected_variants, position)
     SELECT gen_random_uuid(), $1,
            NULLIF(x.product_id, '')::uuid, x.product_name, x.product_slug, x.store_slug,
            x.store_name, x.price_agorot::bigint, x.qty::int, x.image, x.selected_variants, x.position::int
       FROM jsonb_to_recordset($2::jsonb) AS x(
         product_id text, product_name text, product_slug text, store_slug text, store_name text,
         price_agorot bigint, qty int, image text, selected_variants jsonb, position int)`,
    [orderId, JSON.stringify(items.map((it, position) => ({
      // A snapshot line may carry an id that is not a uuid at all (legacy/seed data) — the column
      // is nullable and unenforced for exactly that, so the link is dropped and the snapshot kept.
      product_id: it.productId && isUuid(it.productId) ? it.productId : '',
      product_name: it.productName ?? '',
      product_slug: it.productSlug ?? '',
      store_slug: it.storeSlug ?? '',
      store_name: it.storeName ?? '',
      price_agorot: nonNegative(it.priceAgorot),
      qty: qtyOf(it.qty),
      image: it.image ?? null,
      selected_variants: it.selectedVariants ?? null,
      position,
    })))],
  );
}

async function writeStores(
  tx: Queryable,
  orderId: string,
  subtotals: Record<string, StoreSubtotal>,
  sellerNotes: Record<string, string[]> | undefined,
): Promise<void> {
  // Notes may name a store the subtotals map does not — `orderBelongsToStore` accepts a store that
  // appears only in the items, so a seller can hold a claim on a slice with no subtotal row. The
  // union is what keeps their note from being dropped on the floor.
  const slugs = new Set([...Object.keys(subtotals), ...Object.keys(sellerNotes ?? {})]);
  if (!slugs.size) return;
  const payload = [...slugs].map((slug) => {
    const sub = subtotals[slug];
    const d = sub?.discount;
    return {
      store_slug: slug,
      store_name: sub?.storeName ?? '',
      subtotal_agorot: nonNegative(sub?.subtotalAgorot),
      shipping_agorot: nonNegative(sub?.shippingAgorot),
      delivery_method: sub?.deliveryMethod ?? null,
      discount_type: d?.type ?? null,
      // `discount_percent` is an `integer` column and Postgres would round 12.5 to 12 without a
      // word — leaving the stored percent disagreeing with the `applied` computed from 12.5, so
      // the seller's next edit of that order silently changes its total. Rounded here, where the
      // rest of the app's discount inputs are already rounded (discount-input.ts#clampDiscountValue).
      discount_percent: d?.type === 'percent' ? Math.round(Number(d.value) || 0) : null,
      discount_amount_agorot: d?.type === 'amount' ? nonNegative(Number(d.value) * 100) : null,
      discount_applied_agorot: nonNegative(d?.appliedAgorot),
      // Written only with the discount it explains — see the `couponCode` doc comment. A discount
      // arriving without one clears the column, which is exactly what a seller's own edit of a
      // couponed order must do.
      coupon_code: d && sub?.couponCode ? sub.couponCode : null,
      seller_notes: sellerNotes?.[slug] ?? [],
    };
  });
  await tx.query(
    `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot,
                               delivery_method, discount_type, discount_percent,
                               discount_amount_agorot, discount_applied_agorot, coupon_code, seller_notes)
     SELECT $1, x.store_slug, x.store_name, x.subtotal_agorot, x.shipping_agorot,
            x.delivery_method, x.discount_type, x.discount_percent,
            x.discount_amount_agorot, x.discount_applied_agorot, x.coupon_code, x.seller_notes
       FROM jsonb_to_recordset($2::jsonb) AS x(
         store_slug text, store_name text, subtotal_agorot bigint, shipping_agorot bigint,
         delivery_method text, discount_type text, discount_percent int,
         discount_amount_agorot bigint, discount_applied_agorot bigint, coupon_code text,
         seller_notes text[])`,
    [orderId, JSON.stringify(payload)],
  );
}

/**
 * Create one order with its lines and per-store slices — ONE transaction.
 *
 * A loop of three statements outside a transaction can leave an order row with no lines: the buyer
 * has been charged, the seller's dashboard shows an empty order, and nothing reports it. Inside
 * one, either the whole purchase exists or none of it does.
 *
 * `paymentStatus` comes from the caller — checkout sets it from the PaymentProvider result, so the
 * order records the actual charge outcome rather than assuming it. When a real webhook-based
 * confirm step lands, that becomes the place it flips paid.
 */
/** Attribution → the `jsonb` bind value. See the call site for why `null` and `'null'` differ. */
function attributionOf(attribution: OrderAttribution | undefined): string | null {
  const clean = sanitizeAttribution(attribution);
  return clean ? JSON.stringify(clean) : null;
}

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const id = crypto.randomUUID();
  return withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO orders (id, checkout_ref, buyer_id, buyer_name, buyer_email, buyer_phone,
                           buyer_city, buyer_street, buyer_zip, shipping_agorot, total_agorot,
                           payment_ref, payment_status, shipping_status, tracking_number, attribution)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', $14, $15::jsonb)`,
      [
        id, input.checkoutRef || null,
        input.buyerId && isUuid(input.buyerId) ? input.buyerId : null,
        input.buyerName ?? '', input.buyerEmail ?? '', input.buyerPhone ?? '',
        input.buyerAddress?.city ?? '', input.buyerAddress?.street ?? '', input.buyerAddress?.zip || null,
        nonNegative(input.shippingAgorot), nonNegative(input.totalAgorot),
        input.paymentRef || null, input.paymentStatus,
        input.trackingNumber || null,
        // Cleaned on the way IN as well as on the way out. The caller reads it from a cookie, and a
        // record that would not survive `toOrder` must not be written in the first place — the
        // column would then hold something no reader can see, which is worse than holding nothing.
        //
        // SQL `NULL` for an organic order, never the string `'null'`: `'null'::jsonb` is a JSON null
        // — a present value — and it would put every one of the platform's organic orders inside
        // `orders_attribution_campaign_idx`, whose whole point is that they stay out of it.
        attributionOf(input.attribution),
      ],
    );
    await writeItems(tx, id, input.items ?? []);
    await writeStores(tx, id, input.storeSubtotals ?? {}, input.sellerNotes);
    const [row] = await tx.query<OrderRow>(`${SELECT_ORDERS} WHERE o.id = $1`, [id]).then((r) => r.rows);
    return toOrder(row!);
  });
}

/** Columns an update may touch, keyed by the field name a caller passes.
 *
 *  **Built from `Object.keys(updates)`, never from the values** — the rule `updateStore` needed and
 *  `updateProduct` after it. A caller clearing a tracking number sends `{ trackingNumber: '' }`,
 *  and a loop that skipped falsy values would turn every clear into a silent no-op. */
const ORDER_COLUMNS: Record<string, string> = {
  buyerName: 'buyer_name',
  buyerEmail: 'buyer_email',
  buyerPhone: 'buyer_phone',
  paymentRef: 'payment_ref',
  paymentStatus: 'payment_status',
  shippingStatus: 'shipping_status',
  trackingNumber: 'tracking_number',
  checkoutRef: 'checkout_ref',
};

/**
 * Patch an order. The children are REPLACED as a set when supplied, never merged.
 *
 * `items` / `storeSubtotals` / `sellerNotes` arrive from the seller's order editor as the complete
 * new list — deletions are expressed by absence — so a merge would make a deleted line
 * undeletable. Absent from `updates` entirely means "don't touch", which is the distinction the
 * whole `Object.keys` rule above exists for.
 *
 * One transaction: an order whose lines were rewritten but whose total was not is an order that
 * disagrees with itself on the seller's screen and in `reconcile.ts`.
 */
export async function updateOrder(id: string, updates: Partial<Omit<Order, 'id' | 'createdAt'>>): Promise<Order | null> {
  if (!isUuid(id)) return null;
  return withTransaction(async (tx) => {
    const exists = await tx.query<{ id: string }>('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [id]);
    if (!exists.rows.length) return null;

    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const key of Object.keys(updates)) {
      const column = ORDER_COLUMNS[key];
      if (!column) continue;
      params.push((updates as Record<string, unknown>)[key] ?? null);
      sets.push(`${column} = $${params.length}`);
    }
    if ('shippingAgorot' in updates) {
      params.push(nonNegative(updates.shippingAgorot));
      sets.push(`shipping_agorot = $${params.length}`);
    }
    if ('totalAgorot' in updates) {
      params.push(nonNegative(updates.totalAgorot));
      sets.push(`total_agorot = $${params.length}`);
    }
    if ('buyerAddress' in updates) {
      params.push(updates.buyerAddress?.city ?? '', updates.buyerAddress?.street ?? '', updates.buyerAddress?.zip || null);
      sets.push(`buyer_city = $${params.length - 2}`, `buyer_street = $${params.length - 1}`, `buyer_zip = $${params.length}`);
    }
    await tx.query(`UPDATE orders SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1`, params);

    if ('items' in updates) {
      await tx.query('DELETE FROM order_items WHERE order_id = $1', [id]);
      await writeItems(tx, id, updates.items ?? []);
    }
    if ('storeSubtotals' in updates || 'sellerNotes' in updates) {
      // Both children live in `order_stores`, so a patch of one must carry the other forward or it
      // erases it — the same trap `updateProduct` hit with the two partial variant maps. Whichever
      // half the caller did not supply is read back off the row being replaced.
      const current = toOrder((await tx.query<OrderRow>(`${SELECT_ORDERS} WHERE o.id = $1`, [id])).rows[0]!);
      const subtotals = 'storeSubtotals' in updates ? (updates.storeSubtotals ?? {}) : current.storeSubtotals;
      const notes = 'sellerNotes' in updates ? updates.sellerNotes : current.sellerNotes;
      await tx.query('DELETE FROM order_stores WHERE order_id = $1', [id]);
      await writeStores(tx, id, subtotals, notes);
    }

    const [row] = (await tx.query<OrderRow>(`${SELECT_ORDERS} WHERE o.id = $1`, [id])).rows;
    return row ? toOrder(row) : null;
  });
}

/**
 * Repoint the denormalized storeSlug on every order (the item lines AND the per-store slice) from
 * oldSlug→newSlug when a store's URL is renamed. Without this a seller LOSES all pre-rename orders
 * from their dashboard/revenue (the by-slug queries match by slug) and buyer order-history links
 * would need a 301. Historical prices/names/quantities are untouched — only the URL identifier.
 *
 * Two `UPDATE`s over the whole set rather than a read-modify-write of every affected order: the
 * file version loaded every order on the platform to rename a string in some of them, and a rename
 * that half-applied because the process died between two writes would leave one order's lines under
 * the new slug and its subtotal under the old — an order neither slug can fully claim.
 */
export async function renameStoreSlugInOrders(oldSlug: string, newSlug: string): Promise<void> {
  if (!oldSlug || !newSlug || oldSlug === newSlug) return;
  await withTransaction(async (tx) => {
    await tx.query('UPDATE order_items SET store_slug = $2 WHERE store_slug = $1', [oldSlug, newSlug]);
    // `(order_id, store_slug)` is the primary key, so a store that somehow held both slugs on one
    // order would collide. It cannot today — a rename frees the old slug and `stores.ts` never
    // hands it out again — and if it ever did, the constraint refusing is the right outcome: the
    // alternative is silently merging two financial slices into one.
    await tx.query('UPDATE order_stores SET store_slug = $2 WHERE store_slug = $1', [oldSlug, newSlug]);
  });
}

/**
 * How many of this store's orders sit in one of the given status pairs.
 *
 * The STATUSES are the caller's, not this module's: `store-lifecycle.ts` derives both lists from
 * the rules table (`order-status-rules.ts`), which is the single place that answers "does this
 * status block a store closing". Hard-coding them here would put a second copy of that answer one
 * import away from the table designed to prevent exactly that — and the count decides whether a
 * seller's store is allowed to close, so the two disagreeing means a store closes on a live order.
 *
 * It replaces "load every order this store ever had, then filter": the answer is a number, and the
 * caller only ever wanted the number.
 */
export async function countOrdersByStoreSlug(
  storeSlug: string,
  paymentStatuses: readonly string[],
  shippingStatuses: readonly string[],
): Promise<number> {
  if (!storeSlug || !paymentStatuses.length || !shippingStatuses.length) return 0;
  const row = await firstRow<{ count: string | number }>(
    `SELECT COUNT(*)::bigint AS count FROM orders o
      WHERE o.payment_status = ANY($2::text[])
        AND o.shipping_status = ANY($3::text[])
        AND EXISTS (SELECT 1 FROM order_stores os WHERE os.order_id = o.id AND os.store_slug = $1)`,
    [storeSlug, paymentStatuses, shippingStatuses],
  );
  return bigIntOf(row?.count);
}
