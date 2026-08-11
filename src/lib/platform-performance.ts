import { storeLifecycle, type StoreLifecycle, type StoreLifecycleFlags } from './store-status.js';
import type { Order } from './orders.js';
import {
  assemblePerformanceSummary,
  buildPerformanceSummary,
  buildZeroPoints,
  type PerformanceGranularity,
  type PerformancePoint,
  type PerformanceSummary,
  type TopProduct,
} from './seller-performance.js';
import { EMPTY_STORE_SALES, PRODUCT_QUERY_MAX, type PlatformSales, type StoreSales } from './order-reporting.js';
import { EMPTY_VIEW_STATS, type StoreViewStats } from './store-pageviews.js';
import { blendedCommissionRate, commissionPercentForTier } from './pricing.js';

// Platform-wide ("app-wide") twin of seller-performance.ts's per-store summary,
// for the ADMIN performance tab. It does NOT re-implement any of the bucketing/
// revenue/views math — it calls assemblePerformanceSummary() once per store (the
// single source of that math) and merges the results, so the platform totals
// can never drift from what each store's own performance view reports. The only
// platform-specific logic here is the merge + the per-store breakdown rows.
//
// Cost note, resolved in two steps and both were the same shape. This loop used to do one
// store-pageviews FILE READ per store — 45 per admin render, the reason that module grew a read
// cache at all; views became an input (`viewsByStoreId`), fetched in ONE query for every store.
// **And then (§3, 2026-08-03) so did SALES.** The loop bucketed every order on the platform once
// per store — O(stores × orders), which is 45 × 207 today and 1,000 × 100,000 the moment the
// platform works — and that is now one `GROUP BY` (order-reporting.ts#getPlatformSales). This
// function is pure arithmetic over two pre-aggregated inputs and does no I/O of its own.

export interface PlatformStoreInput {
  /** The store's id — the key page-view statistics are gathered under (slugs change, ids do not). */
  id: string;
  slug: string;
  name: string;
  blocked?: boolean;
  /** Everything else that can take a store off the site (lib/store-status.ts). Carried alongside
   *  `blocked` rather than replacing it — additive, so an older reader keeps working — but the
   *  table renders from THIS, because "blocked" alone would report a store its seller paused or
   *  closed as perfectly normal. */
  state?: StoreLifecycle;
  /** This store's per-sale commission percent, from its SELLER's pricing tier (lib/pricing.ts).
   *  Passed in per store rather than as one platform-wide rate: sellers sit on different tiers,
   *  so a single number would silently misreport the moment the second tier is sold. Absent = 0. */
  commissionPercent?: number;
}

/** Attaches each store's commission rate, resolved from its OWNER's pricing tier — the one place
 *  the store→seller→tier hop is written, so both admin call sites (the dashboard render and the
 *  AJAX endpoint) can never disagree. Pure: the caller supplies both already-read lists. */
export function buildPlatformStoreInputs(
  stores: Array<{ id: string; slug: string; name: string; sellerId: string } & StoreLifecycleFlags>,
  sellers: Array<{ id: string; tier?: string }>,
): PlatformStoreInput[] {
  const tierBySellerId = new Map(sellers.map((s) => [s.id, s.tier]));
  return stores.map((s) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    blocked: s.blocked,
    state: storeLifecycle(s),
    commissionPercent: commissionPercentForTier(tierBySellerId.get(s.sellerId)),
  }));
}

// One row of the "breakdown by store" table — the same headline metrics each
// store's own performance tab shows, so an owner can see which stores actually
// drive the platform.
export interface PlatformStoreRow {
  slug: string;
  name: string;
  blocked: boolean;
  /** What the row's badge says (lib/store-state-badge.ts). Additive next to `blocked`. */
  state?: StoreLifecycle;
  revenueAgorot: number;      // net of seller discount, paid orders only (same basis as seller tab)
  orders: number;       // orders that included this store, in range
  views: number;        // store page views in range
  conversionRate: number; // orders / unique-visitors * 100 (per-store, from buildPerformanceSummary)
  /** Had ANY activity in range — a sale, an order or a page view. Browsing the table
   *  shows only these (a short range would otherwise be mostly all-zero rows); a
   *  SEARCH deliberately reaches past it, so every store is findable by name. */
  active: boolean;
}

export interface PlatformPerformance {
  // Aggregated across every store — identical shape to a single store's summary
  // so the exact same charts / KPI markup / client script (performance.ts) can
  // render it unchanged. `platformCommissionAgorot`/`netProfitAgorot` are re-purposed by the
  // admin panel's LABELS: at platform level the commission is the platform's own
  // income and netProfitAgorot is what gets paid out to sellers (the numbers are the
  // same, only the framing differs from the seller's expense view).
  summary: PerformanceSummary;
  /** EVERY store, revenue-desc, each flagged `active` or not. Never rendered as-is —
   *  the breakdown table is a searchable, paginated view over this (selectStoreRows),
   *  and that view is what decides whether inactive stores are in scope. */
  stores: PlatformStoreRow[];
  /** Stores with activity in range — the default (unsearched) table universe. */
  totalStores: number;
}

// ── Breakdown table: search + sort + pagination ──────────────────────────────
// The table used to be a flat "top 25" list, which both hid the tail and made
// finding one specific store impossible (CURRENT_TASK.md → סשן ב׳ item 1). It's
// now a 10-row page over ALL stores with a name search. Filtering/sorting happen
// here — over the full row set, never over the visible page — so page 2 of a
// search is the real page 2, and the client only ever holds 10 rows.
export const STORE_ROWS_PAGE_SIZE = 10;

export type StoreSortCol = 'name' | 'revenue' | 'orders' | 'views' | 'conversionRate';

/** The row field each sortable column reads. `revenue` is the column a URL names; `revenueAgorot`
 *  is the field that holds it. */
const SORT_FIELD: Record<Exclude<StoreSortCol, 'name'>, keyof PlatformStoreRow> = {
  revenue: 'revenueAgorot',
  orders: 'orders',
  views: 'views',
  conversionRate: 'conversionRate',
};

function numericField(row: PlatformStoreRow, col: StoreSortCol): number {
  if (col === 'name') return 0;
  return Number(row[SORT_FIELD[col]] ?? 0);
}
const SORT_COLS: readonly StoreSortCol[] = ['name', 'revenue', 'orders', 'views', 'conversionRate'];

export interface StoreRowsQuery {
  q: string;
  sort: StoreSortCol;
  dir: 'asc' | 'desc';
  page: number;
}

export interface StoreRowsPage {
  rows: PlatformStoreRow[];   // the requested page, at most STORE_ROWS_PAGE_SIZE
  page: number;               // clamped into [1, totalPages] — the client syncs to this
  totalPages: number;
  matched: number;            // rows matching the search, before paging
  /** Size of the universe this page was drawn from, before the search: the ACTIVE
   *  stores while browsing, EVERY store while searching (see selectStoreRows). */
  total: number;
  query: StoreRowsQuery;      // the normalised query actually applied
}

/** Coerce untrusted params (URL query / dataset) into a valid breakdown query.
 *  Shared by the SSR render and the AJAX endpoint so both normalise identically. */
export function parseStoreRowsQuery(params: URLSearchParams): StoreRowsQuery {
  const sortRaw = params.get('storeSort') ?? '';
  const pageRaw = parseInt(params.get('storePage') ?? '1', 10);
  return {
    // Bounded so a pathological query string can't drive a huge substring scan.
    q: (params.get('storeQ') ?? '').trim().slice(0, 80),
    sort: SORT_COLS.includes(sortRaw as StoreSortCol) ? (sortRaw as StoreSortCol) : 'revenue',
    dir: params.get('storeDir') === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** Search → sort → paginate, in that order (the same order the DB query will run in
 *  after the migration: WHERE name ILIKE … ORDER BY … LIMIT … OFFSET …). Pure.
 *
 *  The universe depends on whether there IS a search. Browsing shows only stores with
 *  activity in range — otherwise a one-day range is 40 all-zero rows and the table is
 *  useless. But a search is a lookup of a store the owner already has in mind, and
 *  "no results" for a store that plainly exists reads as a broken feature, so a search
 *  spans EVERY store; the zero-activity ones come back flagged `active:false` for the
 *  UI to label rather than silently showing zeros. */
export function selectStoreRows(rows: PlatformStoreRow[], query: StoreRowsQuery): StoreRowsPage {
  const q = query.q.toLowerCase();
  const universe = q ? rows : rows.filter((r) => r.active);
  // Slug as well as name: an owner who knows the store's URL can paste it.
  const matches = q
    ? universe.filter((r) => r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q))
    : universe;

  const dir = query.dir === 'asc' ? 1 : -1;
  const sorted = [...matches].sort((a, b) => (
    query.sort === 'name'
      // localeCompare with 'he' so Hebrew store names sort alphabetically rather
      // than by code point (which interleaves them arbitrarily against Latin ones).
      ? a.name.localeCompare(b.name, 'he') * dir
      // The sort COLUMN is a URL value (`?sort=revenue`) and the FIELD it reads carries its unit
      // (`revenueAgorot`). They were the same word until the unit flip; keeping them the same word
      // would have meant renaming a public query parameter to say "agorot", which is nobody's
      // business but this module's.
      : (numericField(a, query.sort) - numericField(b, query.sort)) * dir
  ));

  const totalPages = Math.max(1, Math.ceil(sorted.length / STORE_ROWS_PAGE_SIZE));
  const page = Math.min(Math.max(1, query.page), totalPages);
  const start = (page - 1) * STORE_ROWS_PAGE_SIZE;
  return {
    rows: sorted.slice(start, start + STORE_ROWS_PAGE_SIZE),
    page,
    totalPages,
    matched: sorted.length,
    total: universe.length,
    query: { ...query, page },
  };
}

/**
 * The pure twin of `order-reporting.ts#getPlatformSales` — the same aggregation, over an order
 * array the caller already holds.
 *
 * It is not on the render path and it is not meant to be: it buckets every order once per store,
 * which is precisely the O(stores × orders) shape §3 moved into the database. What it IS good for
 * is being checkable — `tests/reporting-invariants.test.ts` runs it and the query over the same
 * rows and requires the same answer, and every invariant about platform money can be stated over
 * hand-built orders with no database at all. Same arrangement as `purchasedCountsFrom` beside
 * `getPurchasedCountsByStoreSlugs`.
 */
export function buildPlatformSales(
  orders: Order[],
  storeSlugs: readonly string[],
  fromISO: string,
  toISO: string,
  granularity: PerformanceGranularity,
  topLimit = 5,
  productQuery = '',
): PlatformSales {
  const byStore = new Map<string, StoreSales>();
  const productMap = new Map<string, TopProduct>();
  for (const slug of new Set(storeSlugs)) {
    const s = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, slug, fromISO, toISO, granularity, 0, 0);
    byStore.set(slug, {
      // Zero buckets are dropped: the query only returns groups that exist, and the axis is
      // rebuilt from the dates either way.
      buckets: s.points.filter((p) => p.revenueAgorot !== 0 || p.orders !== 0)
        .map((p) => ({ key: p.key, revenueAgorot: p.revenueAgorot, orders: p.orders })),
      totalRevenueAgorot: s.totalRevenueAgorot,
      totalOrders: s.totalOrders,
    });
    for (const tp of s.topProducts) {
      const entry = productMap.get(tp.productId)
        ?? { productId: tp.productId, name: tp.name, revenueAgorot: 0, units: 0, storeSlug: tp.storeSlug, storeName: tp.storeName };
      entry.revenueAgorot += tp.revenueAgorot;
      entry.units += tp.units;
      productMap.set(tp.productId, entry);
    }
  }
  const sorted = [...productMap.values()].sort((a, b) => b.revenueAgorot - a.revenueAgorot);
  // The denominator is taken before the filter and before the cap, exactly as the query's inner
  // window is — a searched row still reports its share of the period, not of the search.
  const productRevenueAgorot = sorted.reduce((s, p) => s + p.revenueAgorot, 0);
  const q = productQuery.trim().slice(0, PRODUCT_QUERY_MAX).toLowerCase();
  const matching = q ? sorted.filter((p) => p.name.toLowerCase().includes(q)) : sorted;
  return {
    byStore,
    topProducts: topLimit > 0 ? matching.slice(0, topLimit) : matching,
    // Empty match → 0, the same answer the query gives when its windows have no row to ride on.
    productRevenueAgorot: matching.length ? productRevenueAgorot : 0,
    productsMatched: matching.length,
  };
}

/**
 * Aggregates every store's performance into one platform-wide PerformanceSummary
 * plus a per-store breakdown, over [fromISO, toISO]. Pure given its inputs — `sales` is the money
 * data and `viewsByStoreId` the traffic data, both fetched once by the caller in one query each.
 * The breakdown rows are returned in full — paging/search is the caller's job (selectStoreRows).
 *
 * `sales.topProducts` arrives already ranked and capped: the leaderboard is `ORDER BY revenue DESC
 * LIMIT n` in the query, which is a true platform top-N. Merging per-store top-5s here would have
 * produced a top-N of each store's top-5, a different and quietly wrong list.
 *
 * Note: unique visitors are SUMMED across stores (a browser visiting two stores
 * is counted once per store), so the platform figure is an upper bound. Exact
 * cross-store de-dup is one `COUNT(DISTINCT visitor_id)` without the store filter,
 * and is deliberately not attempted here: this function merges per-store results
 * and has none of the underlying ids, by design.
 */
export function buildPlatformPerformance(
  sales: PlatformSales,
  stores: PlatformStoreInput[],
  viewsByStoreId: ReadonlyMap<string, StoreViewStats>,
  fromISO: string,
  toISO: string,
  granularity: PerformanceGranularity,
): PlatformPerformance {
  // Zero-filled point skeleton for the whole range, derived straight from the
  // dates — the exact x-axis keys/labels the seller math produces, so the merge
  // below just adds onto it (an empty platform still charts a flat range, not a
  // blank box) without a throwaway summary pass over a fake store.
  const points: PerformancePoint[] = buildZeroPoints(fromISO, toISO, granularity);
  const keyIndex = new Map(points.map((p, i) => [p.key, i]));

  const rows: PlatformStoreRow[] = [];
  let totalRevenueAgorot = 0;
  // Orders are summed per store: a rare multi-store order counts toward each
  // store it touched, so the platform "orders" figure reconciles exactly with
  // the sum of the breakdown rows (what the owner sees when scanning the table).
  let totalOrders = 0;
  let totalViews = 0;
  let totalUniqueVisitors = 0;
  // Summed from each store's OWN tier rate — never one rate applied to the platform total.
  let totalCommission = 0;

  for (const store of stores) {
    const s = assemblePerformanceSummary(
      sales.byStore.get(store.slug) ?? EMPTY_STORE_SALES,
      viewsByStoreId.get(store.id) ?? EMPTY_VIEW_STATS,
      fromISO, toISO, granularity, store.commissionPercent ?? 0,
    );
    totalRevenueAgorot += s.totalRevenueAgorot;
    totalCommission += s.platformCommissionAgorot;
    totalOrders += s.totalOrders;
    totalViews += s.totalViews;
    totalUniqueVisitors += s.totalUniqueVisitors;

    for (const p of s.points) {
      const i = keyIndex.get(p.key);
      if (i === undefined) continue;
      points[i]!.revenueAgorot += p.revenueAgorot;
      points[i]!.orders += p.orders;
      points[i]!.views += p.views;
      points[i]!.uniqueVisitors += p.uniqueVisitors;
    }

    // EVERY store gets a row (its summary was computed either way — this costs
    // nothing extra). Whether a no-activity store is actually shown is decided
    // downstream by selectStoreRows: hidden while browsing, findable by search.
    rows.push({
      slug: store.slug,
      name: store.name,
      blocked: store.blocked ?? false,
      state: store.state ?? storeLifecycle(store),
      revenueAgorot: s.totalRevenueAgorot,
      orders: s.totalOrders,
      views: s.totalViews,
      conversionRate: s.conversionRate,
      active: s.totalRevenueAgorot > 0 || s.totalOrders > 0 || s.totalViews > 0,
    });
  }

  const topProducts = sales.topProducts;

  // Each store's commission was rounded to the agora against its OWN tier rate (that is why this
  // sums per-store figures rather than applying one blended rate to the platform total), so the
  // sum is already whole.
  const platformCommissionAgorot = totalCommission;
  const netProfitAgorot = totalRevenueAgorot - platformCommissionAgorot;
  // Conversion = orders / unique visitors (matches the seller tab's definition),
  // falling back to total views when no visitor ids exist (legacy/demo data).
  const conversionRate = totalUniqueVisitors > 0
    ? (totalOrders / totalUniqueVisitors) * 100
    : totalViews > 0 ? (totalOrders / totalViews) * 100 : 0;

  const summary: PerformanceSummary = {
    granularity,
    points,
    totalRevenueAgorot,
    totalOrders,
    avgOrderValueAgorot: totalOrders > 0 ? Math.round(totalRevenueAgorot / totalOrders) : 0,
    totalViews,
    totalUniqueVisitors,
    conversionRate,
    topProducts,
    // Straight from the query's own window (order-reporting.ts) — the platform's whole product
    // revenue for the period. Never re-derived from `topProducts` here: this list is capped and
    // may be filtered, and summing it would make the shares add to 100% by construction.
    productRevenueAgorot: sales.productRevenueAgorot,
    // Revenue-weighted actual, not any one tier's rate — the only honest headline across a
    // mixed-tier seller base (see pricing.ts#blendedCommissionRate).
    commissionRate: blendedCommissionRate(totalRevenueAgorot, platformCommissionAgorot),
    platformCommissionAgorot,
    netProfitAgorot,
  };

  const sortedRows = rows.sort((a, b) => b.revenueAgorot - a.revenueAgorot);
  return { summary, stores: sortedRows, totalStores: sortedRows.filter((r) => r.active).length };
}
