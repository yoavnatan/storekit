import fs from 'node:fs';
import path from 'node:path';
import { Mutex } from './mutex.js';

const PRODUCT_PAGEVIEWS_PATH = path.join(process.cwd(), 'data/product-pageviews.json');

// Per-product daily view counter, the product-level twin of store-pageviews.ts.
// Keyed by the product's stable id (NOT its slug — a rename changes the slug but
// the id is forever, so history survives) → { 'YYYY-MM-DD': totalViews }.
//
// A "view" is counted from two surfaces (CURRENT_TASK.md, סשן א׳): a full
// product-page load (tapped in middleware) AND a quick-view/product-modal open
// (tapped in /api/store-product, the modal's data source) — a lot of product
// viewing happens in the modal without ever hitting the page, so counting only
// page loads would undercount real interest.
//
// TOTAL views only, no per-visitor set: this is "how many times was the product
// viewed" over a range. A per-product unique-visitor count would multiply storage
// by every distinct browser per product per day for marginal extra signal, so
// uniqueness is left to the store-level metric. A DB swap replaces this map with
// a ProductView(productId, date) table where COUNT(*) per (productId, date range)
// gives the same number, dropping the mutex-guarded read-modify-write for an
// indexed upsert.
type ProductPageviewStore = Record<string, Record<string, number>>;

export interface DailyProductView { date: string; views: number }

function readAll(): ProductPageviewStore {
  try { return JSON.parse(fs.readFileSync(PRODUCT_PAGEVIEWS_PATH, 'utf8')) as ProductPageviewStore; }
  catch { return {}; }
}

function writeAll(data: ProductPageviewStore): void {
  fs.writeFileSync(PRODUCT_PAGEVIEWS_PATH, JSON.stringify(data, null, 2));
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

const productPageviewMutex = new Mutex();

/** Fire-and-forget from middleware — bumps today's load count for one product. Never throws (analytics must never break page rendering). */
export function recordProductView(productId: string): void {
  if (!productId) return;
  productPageviewMutex.run(() => {
    const all = readAll();
    const forProduct = all[productId] ?? {};
    const key = todayKey();
    forProduct[key] = (forProduct[key] ?? 0) + 1;
    all[productId] = forProduct;
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

/** Zero-filled daily view series across [fromISO, toISO] (both 'YYYY-MM-DD', inclusive) for one product — no gaps for days with no traffic, ready to bucket by day/month. */
export function getProductDailyViews(productId: string, fromISO: string, toISO: string): DailyProductView[] {
  const forProduct = readAll()[productId] ?? {};
  return dateRange(fromISO, toISO).map((date) => ({ date, views: forProduct[date] ?? 0 }));
}

/** Total loads for a product across [fromISO, toISO] inclusive. */
export function getProductViewsInRange(productId: string, fromISO: string, toISO: string): number {
  return getProductDailyViews(productId, fromISO, toISO).reduce((sum, d) => sum + d.views, 0);
}
