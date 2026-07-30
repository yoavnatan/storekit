import fs from 'node:fs';
import path from 'node:path';
import { Mutex } from './mutex.js';
import { businessDayISO, calendarDayISO } from './business-day.js';

const PAGEVIEWS_PATH = path.join(process.cwd(), 'data/store-pageviews.json');

// Daily bucket per store. `total` counts every raw page load (store page + its
// product pages); `visitors` holds the DISTINCT visitor ids seen that day, so
// "unique visitors" can be computed exactly across any range (union of the
// daily sets) — separating "one person entering many times" from "many
// different people". A repeat load by the same visitor only bumps `total`, so
// storage stays O(days × unique-visitors-per-day), not O(all loads). A DB swap
// replaces the bucket map with a `PageView(storeSlug, date, visitorId)` table:
// `COUNT(*)` gives total loads, `COUNT(DISTINCT visitorId)` the unique
// visitors, replacing this mutex-guarded read-modify-write with an upsert.
//
// Legacy/demo rows may be a bare `number` (total only, no visitor ids) — read
// coerces those to { total, visitors: [] }, so old data still charts (its
// unique count is simply 0 until real cookie-backed traffic accrues).
interface DayBucket { total: number; visitors: string[] }
type StoredBucket = DayBucket | number;
type PageviewStore = Record<string, Record<string, StoredBucket>>;

export interface DailyPageView { date: string; views: number; visitors: string[] }

function readAll(): PageviewStore {
  try { return JSON.parse(fs.readFileSync(PAGEVIEWS_PATH, 'utf8')) as PageviewStore; }
  catch { return {}; }
}

function writeAll(data: PageviewStore): void {
  fs.writeFileSync(PAGEVIEWS_PATH, JSON.stringify(data, null, 2));
}

/** Coerce a stored bucket (which may be a legacy bare number) into the full shape. */
function normalizeBucket(v: StoredBucket | undefined): DayBucket {
  if (v == null) return { total: 0, visitors: [] };
  if (typeof v === 'number') return { total: v, visitors: [] };
  return { total: v.total ?? 0, visitors: Array.isArray(v.visitors) ? v.visitors : [] };
}

/** The BUSINESS day (business-day.ts), not the UTC one. These buckets share an x-axis
 *  with revenue in the seller's performance tab, and the conversion rate divides one
 *  by the other — so a visit and the purchase it produced, both at 01:00 local, have
 *  to land in the same bucket. Under UTC they didn't: the visit went to the previous
 *  day and the order stayed on today. */
function todayKey(): string {
  return businessDayISO(new Date());
}

const pageviewMutex = new Mutex();

/** Move a store's page-view history from oldSlug to newSlug (merging per-day buckets if newSlug
 *  already has some) so a URL rename doesn't split or lose the seller's visitor analytics. Returns a
 *  promise the caller can await before responding. See stores.ts → renameStoreSlug. */
export function renameStoreSlugInPageviews(oldSlug: string, newSlug: string): Promise<void> {
  if (!oldSlug || oldSlug === newSlug) return Promise.resolve();
  return pageviewMutex.run(() => {
    const all = readAll();
    const from = all[oldSlug];
    if (!from) return;
    const into = all[newSlug] ?? {};
    for (const [date, raw] of Object.entries(from)) {
      const a = normalizeBucket(into[date]);
      const b = normalizeBucket(raw);
      into[date] = { total: a.total + b.total, visitors: Array.from(new Set([...a.visitors, ...b.visitors])) };
    }
    all[newSlug] = into;
    delete all[oldSlug];
    writeAll(all);
  }).catch(() => undefined);
}

/** Fire-and-forget from middleware — bumps today's total load count for a store and, when a stable visitor id is supplied, records it once (repeat loads by the same visitor never inflate the unique count). Never throws (caller must not let analytics failures break page rendering). */
export function recordPageView(storeSlug: string, visitorId?: string): void {
  pageviewMutex.run(() => {
    const all = readAll();
    const forStore = all[storeSlug] ?? {};
    const key = todayKey();
    const bucket = normalizeBucket(forStore[key]);
    bucket.total += 1;
    if (visitorId && !bucket.visitors.includes(visitorId)) bucket.visitors.push(visitorId);
    forStore[key] = bucket;
    all[storeSlug] = forStore;
    writeAll(all);
  }).catch(() => undefined);
}

function dateRange(fromISO: string, toISO: string): string[] {
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

/** Zero-filled daily series across [fromISO, toISO] (both 'YYYY-MM-DD', inclusive) — ready to bucket/union directly, no gaps for days with no traffic. `views` = total loads that day; `visitors` = the distinct visitor ids seen (empty for legacy/demo rows). */
export function getDailyPageViews(storeSlug: string, fromISO: string, toISO: string): DailyPageView[] {
  const forStore = readAll()[storeSlug] ?? {};
  return dateRange(fromISO, toISO).map((date) => {
    const b = normalizeBucket(forStore[date]);
    return { date, views: b.total, visitors: b.visitors };
  });
}

export function getPageViewsInRange(storeSlug: string, fromISO: string, toISO: string): number {
  return getDailyPageViews(storeSlug, fromISO, toISO).reduce((sum, d) => sum + d.views, 0);
}
