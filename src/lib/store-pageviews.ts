import fs from 'node:fs';
import path from 'node:path';
import { Mutex } from './mutex.js';

const PAGEVIEWS_PATH = path.join(process.cwd(), 'data/store-pageviews.json');

// Daily bucket per store — not a per-visit log. Keeps writes/reads O(days),
// not O(views), so this stays cheap at real traffic volume; a DB swap
// replaces the bucket map with a `PageView(storeSlug, date, count)` table and
// an atomic UPDATE ... SET count = count + 1 instead of this mutex.
// Counts raw page loads (store page + its product pages), not unique
// visitors — no session/cookie dedup, deliberately simple for a first pass.
type PageviewStore = Record<string, Record<string, number>>;

function readAll(): PageviewStore {
  try { return JSON.parse(fs.readFileSync(PAGEVIEWS_PATH, 'utf8')) as PageviewStore; }
  catch { return {}; }
}

function writeAll(data: PageviewStore): void {
  fs.writeFileSync(PAGEVIEWS_PATH, JSON.stringify(data, null, 2));
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

const pageviewMutex = new Mutex();

/** Fire-and-forget from middleware — increments today's bucket for a store. Never throws (caller must not let analytics failures break page rendering). */
export function recordPageView(storeSlug: string): void {
  pageviewMutex.run(() => {
    const all = readAll();
    const forStore = all[storeSlug] ?? {};
    const key = todayKey();
    forStore[key] = (forStore[key] ?? 0) + 1;
    all[storeSlug] = forStore;
    writeAll(all);
  }).catch(() => undefined);
}

function dateRange(fromISO: string, toISO: string): string[] {
  const dates: string[] = [];
  const cur = new Date(fromISO + 'T00:00:00Z');
  const end = new Date(toISO + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/** Zero-filled daily series across [fromISO, toISO] (both 'YYYY-MM-DD', inclusive) — ready to chart directly, no gaps for days with no traffic. */
export function getDailyPageViews(storeSlug: string, fromISO: string, toISO: string): { date: string; views: number }[] {
  const forStore = readAll()[storeSlug] ?? {};
  return dateRange(fromISO, toISO).map((date) => ({ date, views: forStore[date] ?? 0 }));
}

export function getPageViewsInRange(storeSlug: string, fromISO: string, toISO: string): number {
  return getDailyPageViews(storeSlug, fromISO, toISO).reduce((sum, d) => sum + d.views, 0);
}
