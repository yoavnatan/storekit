import fs from 'node:fs';
import path from 'node:path';
import { Mutex } from './mutex.js';
import { businessDayISO, calendarDayISO } from './business-day.js';

const ANALYTICS_PATH = path.join(process.cwd(), 'data/analytics-events.json');

// The buyer funnel, ordered top → bottom. Each is a FIRST-PARTY event we capture
// ourselves — deliberately independent of the GTM/Meta dataLayer, which only
// forwards events to third parties and stores nothing we can query for our own
// business insights. 'page_view' is the top (any HTML page load); each later
// stage narrows toward a completed purchase.
export const FUNNEL_EVENTS = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'] as const;
// Events captured the same way but OUTSIDE the buyer funnel — currently the top
// of the SELLER onboarding funnel (a visit to the seller registration page). Kept
// in the same store/record path; buildFunnel() iterates only FUNNEL_EVENTS.
export const AUX_EVENTS = ['seller_register_view'] as const;
export type FunnelEvent = typeof FUNNEL_EVENTS[number];
export type AnalyticsEvent = FunnelEvent | typeof AUX_EVENTS[number];

// Per-day, per-event bucket. `count` = raw occurrences (volume — page loads, add
// clicks…). `visitors` = the DISTINCT session ids (the httpOnly `sn_vid` cookie)
// that fired the event that day, so a funnel STAGE is measured in SESSIONS
// (union of the daily id sets across a range), separating "one session, many
// adds" from "many different sessions". `products` = per-product occurrence
// counts, kept only for product-scoped events (view_item / add_to_cart /
// purchase) — powers the top-products and cart-abandonment-by-product
// breakdowns. Storage is O(days × events × unique-sessions-per-day): dev-only
// JSON, swap-ready for a DB `AnalyticsEvent(date,type,vid,productId)` table
// where COUNT / COUNT(DISTINCT vid) replace this mutex-guarded read-modify-write.
interface EventBucket { count: number; visitors: string[]; products?: Record<string, number> }
type DayBuckets = Partial<Record<AnalyticsEvent, EventBucket>>;
export type AnalyticsData = Record<string, DayBuckets>; // date 'YYYY-MM-DD' → per-event buckets

function readAll(): AnalyticsData {
  try { return JSON.parse(fs.readFileSync(ANALYTICS_PATH, 'utf8')) as AnalyticsData; }
  catch { return {}; }
}

function writeAll(data: AnalyticsData): void {
  fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(data, null, 2));
}

function normalizeBucket(v: EventBucket | undefined): EventBucket {
  if (v == null) return { count: 0, visitors: [] };
  return {
    count: v.count ?? 0,
    visitors: Array.isArray(v.visitors) ? v.visitors : [],
    products: v.products && typeof v.products === 'object' ? v.products : undefined,
  };
}

/** The BUSINESS day (business-day.ts). The funnel counts add_to_cart against purchase,
 *  and purchases are bucketed on the business calendar — under UTC a late-night
 *  session could file its cart event on one day and its purchase on the next, which
 *  shows up as a conversion rate over 100% on one day and a hole on the other. */
function todayKey(): string {
  return businessDayISO(new Date());
}

const analyticsMutex = new Mutex();

export interface RecordOpts { vid?: string; productIds?: string[]; date?: string }

/**
 * Fire-and-forget event record. Bumps today's raw count for `type`, records the
 * session id once (repeat fires by the same session never inflate the stage's
 * session count), and tallies each product id. NEVER throws — analytics must not
 * break page rendering or checkout (the caller wraps nothing).
 */
export function recordAnalyticsEvent(type: AnalyticsEvent, opts: RecordOpts = {}): void {
  analyticsMutex.run(() => {
    const all = readAll();
    const key = opts.date ?? todayKey();
    const day = all[key] ?? {};
    const bucket = normalizeBucket(day[type]);
    bucket.count += 1;
    if (opts.vid && !bucket.visitors.includes(opts.vid)) bucket.visitors.push(opts.vid);
    if (opts.productIds?.length) {
      const products = bucket.products ?? {};
      for (const pid of opts.productIds) products[pid] = (products[pid] ?? 0) + 1;
      bucket.products = products;
    }
    day[type] = bucket;
    all[key] = day;
    writeAll(all);
  }).catch(() => undefined);
}

// ── Pure aggregation (take a raw AnalyticsData, no I/O — directly unit-testable) ──

function datesInRange(fromISO: string, toISO: string): string[] {
  const dates: string[] = [];
  const cur = new Date(fromISO + 'T00:00:00Z');
  const end = new Date(toISO + 'T00:00:00Z');
  while (cur <= end) {
    // A synthetic calendar cursor, not a moment in time (see business-day.ts —
    // mixing the two families up is the bug that file exists to prevent).
    dates.push(calendarDayISO(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

interface EventAggregate { sessions: number; count: number; products: Record<string, number> }

/** Union distinct sessions + sum counts + merge product tallies for one event across [from,to]. */
function aggregateEvent(data: AnalyticsData, type: AnalyticsEvent, dates: string[]): EventAggregate {
  const sessionIds = new Set<string>();
  const products: Record<string, number> = {};
  let count = 0;
  for (const date of dates) {
    const b = data[date]?.[type];
    if (!b) continue;
    count += b.count ?? 0;
    for (const id of b.visitors ?? []) sessionIds.add(id);
    for (const [pid, n] of Object.entries(b.products ?? {})) products[pid] = (products[pid] ?? 0) + n;
  }
  return { sessions: sessionIds.size, count, products };
}

export interface FunnelStage { event: FunnelEvent; sessions: number; count: number }

/** The buyer funnel over a range: one stage per FUNNEL_EVENTS entry, measured in sessions. */
export function buildFunnel(data: AnalyticsData, fromISO: string, toISO: string): FunnelStage[] {
  const dates = datesInRange(fromISO, toISO);
  return FUNNEL_EVENTS.map((event) => {
    const a = aggregateEvent(data, event, dates);
    return { event, sessions: a.sessions, count: a.count };
  });
}

export interface AnalyticsRates {
  sessions: number;
  productViews: number;
  addToCarts: number;
  checkouts: number;
  purchases: number;
  bounceRate: number;             // sessions that never viewed a product (landed + left)
  cartAbandonmentRate: number;    // added to cart but never purchased
  checkoutAbandonmentRate: number;// reached checkout but never purchased
  conversionRate: number;         // purchasing sessions / all sessions
}

const rate = (part: number, whole: number): number => (whole > 0 ? Math.max(0, Math.min(1, part / whole)) * 100 : 0);

export function buildAnalyticsRates(data: AnalyticsData, fromISO: string, toISO: string): AnalyticsRates {
  const dates = datesInRange(fromISO, toISO);
  const sessions = aggregateEvent(data, 'page_view', dates).sessions;
  const productViews = aggregateEvent(data, 'view_item', dates).sessions;
  const addToCarts = aggregateEvent(data, 'add_to_cart', dates).sessions;
  const checkouts = aggregateEvent(data, 'begin_checkout', dates).sessions;
  const purchases = aggregateEvent(data, 'purchase', dates).sessions;
  return {
    sessions, productViews, addToCarts, checkouts, purchases,
    bounceRate: rate(sessions - productViews, sessions),
    cartAbandonmentRate: rate(addToCarts - purchases, addToCarts),
    checkoutAbandonmentRate: rate(checkouts - purchases, checkouts),
    conversionRate: rate(purchases, sessions),
  };
}

export interface ProductStat { productId: string; count: number }

/** Top product ids by occurrence of `type` (e.g. most added-to-cart) across a range. */
export function topProductsByEvent(data: AnalyticsData, type: AnalyticsEvent, fromISO: string, toISO: string, limit = 8): ProductStat[] {
  const { products } = aggregateEvent(data, type, datesInRange(fromISO, toISO));
  return Object.entries(products)
    .map(([productId, count]) => ({ productId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export interface AbandonedProduct { productId: string; added: number; purchased: number; abandoned: number }

/** Products added to carts but not bought — the demand-vs-conversion gap, per product. */
export function topAbandonedProducts(data: AnalyticsData, fromISO: string, toISO: string, limit = 8): AbandonedProduct[] {
  const dates = datesInRange(fromISO, toISO);
  const added = aggregateEvent(data, 'add_to_cart', dates).products;
  const bought = aggregateEvent(data, 'purchase', dates).products;
  return Object.entries(added)
    .map(([productId, addCount]) => {
      const purchased = bought[productId] ?? 0;
      return { productId, added: addCount, purchased, abandoned: Math.max(0, addCount - purchased) };
    })
    .filter((p) => p.abandoned > 0)
    .sort((a, b) => b.abandoned - a.abandoned)
    .slice(0, limit);
}

export interface AnalyticsOverview {
  funnel: FunnelStage[];
  rates: AnalyticsRates;
  topAdded: ProductStat[];
  topAbandoned: AbandonedProduct[];
}

/** Everything the admin data tab needs, from one pass over the raw data (pure — testable). */
export function buildAnalyticsOverview(data: AnalyticsData, fromISO: string, toISO: string): AnalyticsOverview {
  return {
    funnel: buildFunnel(data, fromISO, toISO),
    rates: buildAnalyticsRates(data, fromISO, toISO),
    topAdded: topProductsByEvent(data, 'add_to_cart', fromISO, toISO),
    topAbandoned: topAbandonedProducts(data, fromISO, toISO),
  };
}

/** I/O wrapper — reads the store once and computes the full overview for the range. */
export function getAnalyticsOverview(fromISO: string, toISO: string): AnalyticsOverview {
  return buildAnalyticsOverview(readAll(), fromISO, toISO);
}

/** Distinct sessions that fired `type` across ALL recorded days — for lifetime
 *  figures like the seller-onboarding funnel's "visited register page" top. */
export function getLifetimeEventSessions(type: AnalyticsEvent): number {
  const data = readAll();
  return aggregateEvent(data, type, Object.keys(data)).sessions;
}
