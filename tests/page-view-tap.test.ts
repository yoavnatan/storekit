/**
 * One page view is one round trip — against a real Postgres.
 *
 * The point of `page-view-tap.ts` is not that it writes the right rows (three modules already did
 * that); it is that all of them travel in ONE statement. A product page used to issue four writes
 * from three modules, four of the five round trips a page load spends, and each of those modules
 * was individually correct — the cost only existed between them, which is exactly the kind of thing
 * no per-module test can see. So this file pins both halves: the effects, and the single statement.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { query, rows } from '../src/lib/db.js';
import { businessDayISO } from '../src/lib/business-day.js';
import { recordPageViewTap } from '../src/lib/page-view-tap.js';

const KERAMIKA = '22222222-2222-4222-8222-000000000001';
/** Asked FRESH, never frozen at module load — a suite that crosses midnight in Asia/Jerusalem
 *  otherwise writes into one business day and reads the other, and every assertion comes back 0
 *  with nothing in the message to suggest a clock. Turned CI red on 2026-08-20 at 00:0x in
 *  `store-pageviews-db.test.ts`, which carries the full note. */
const businessToday = () => businessDayISO(new Date());

let seq = 0;
async function freshProduct(): Promise<string> {
  seq += 1;
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock)
     VALUES ($1, $2, $3, 'T', 100, 1)`,
    [id, KERAMIKA, `tap-prod-${seq}-${crypto.randomBytes(3).toString('hex')}`],
  );
  return id;
}

const one = async <T>(sql: string, params: unknown[]): Promise<T | undefined> =>
  (await rows<T>(sql, params))[0];

const productViews = (productId: string) =>
  one<{ total: number }>('SELECT total FROM product_page_views WHERE product_id = $1 AND day = $2::date', [productId, businessToday()]);
const storeViews = (storeId: string) =>
  one<{ total: number }>('SELECT total FROM store_page_views WHERE store_id = $1 AND day = $2::date', [storeId, businessToday()]);
const storeUniques = async (storeId: string): Promise<number> =>
  Number((await one<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM store_page_view_visitors WHERE store_id = $1 AND day = $2::date', [storeId, businessToday()]))?.n ?? 0);
const eventCount = async (event: string): Promise<number> =>
  Number((await one<{ count: number | string }>(
    'SELECT count FROM analytics_daily WHERE day = $1::date AND event = $2', [businessToday(), event]))?.count ?? 0);
const eventSessions = async (event: string, vid: string): Promise<number> =>
  Number((await one<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM analytics_visitors WHERE day = $1::date AND event = $2 AND visitor_id = $3',
    [businessToday(), event, vid]))?.n ?? 0);
const productTally = async (event: string, productId: string): Promise<number> =>
  Number((await one<{ count: number | string }>(
    'SELECT count FROM analytics_products WHERE day = $1::date AND event = $2 AND product_id = $3',
    [businessToday(), event, productId]))?.count ?? 0);

describe('one product-page view writes all six tables', () => {
  it('records the funnel, the store counter and the product counter in a single call', async () => {
    const productId = await freshProduct();
    const vid = `tap-${crypto.randomBytes(6).toString('hex')}`;
    const beforePageView = await eventCount('page_view');
    const beforeViewItem = await eventCount('view_item');
    const beforeStore = (await storeViews(KERAMIKA))?.total ?? 0;

    await recordPageViewTap({
      events: ['page_view', 'view_item'],
      visitorId: vid,
      storeId: KERAMIKA,
      productId,
      productEvent: 'view_item',
      productIds: [productId],
    });

    expect(await eventCount('page_view')).toBe(beforePageView + 1);
    expect(await eventCount('view_item')).toBe(beforeViewItem + 1);
    expect(await eventSessions('page_view', vid)).toBe(1);
    expect(await eventSessions('view_item', vid)).toBe(1);
    expect(await productTally('view_item', productId)).toBe(1);
    expect((await storeViews(KERAMIKA))?.total).toBe(beforeStore + 1);
    expect((await productViews(productId))?.total).toBe(1);
  });

  it('counts the same session twice in volume and once in reach', async () => {
    // The two numbers answer different questions and this is where they diverge: loads go up on
    // every view, the session is filed once. A refresh loop must not invent unique visitors.
    const productId = await freshProduct();
    const vid = `tap-${crypto.randomBytes(6).toString('hex')}`;
    const tap = { events: ['page_view'] as const, visitorId: vid, storeId: KERAMIKA, productId };
    const beforeStore = (await storeViews(KERAMIKA))?.total ?? 0;

    await recordPageViewTap(tap);
    await recordPageViewTap(tap);

    expect((await storeViews(KERAMIKA))?.total).toBe(beforeStore + 2);
    expect((await productViews(productId))?.total).toBe(2);
    expect(await eventSessions('page_view', vid)).toBe(1);
  });

  it('tolerates the same event named twice — Postgres would reject the row being touched twice', async () => {
    const vid = `tap-${crypto.randomBytes(6).toString('hex')}`;
    const before = await eventCount('page_view');
    await recordPageViewTap({ events: ['page_view', 'page_view'], visitorId: vid });
    // Deduplicated, so it is one increment and not an error swallowed by the catch — which is what
    // the assertion is really testing: a raised statement would leave this unchanged.
    expect(await eventCount('page_view')).toBe(before + 1);
  });

  it('tallies a product named twice in one call as two', async () => {
    // A checkout with two variants of the same product does this. The GROUP BY exists for it.
    const productId = await freshProduct();
    await recordPageViewTap({ events: ['purchase'], productEvent: 'purchase', productIds: [productId, productId] });
    expect(await productTally('purchase', productId)).toBe(2);
  });

  it('drops a non-uuid product id without losing the rest of the page view', async () => {
    // The old recordProductView returned EARLY on a bad id. Inside one statement that would have
    // thrown away the funnel event and the store counter with it.
    const vid = `tap-${crypto.randomBytes(6).toString('hex')}`;
    const beforeStore = (await storeViews(KERAMIKA))?.total ?? 0;
    await recordPageViewTap({ events: ['page_view'], visitorId: vid, storeId: KERAMIKA, productId: 'not-a-uuid' });
    expect((await storeViews(KERAMIKA))?.total).toBe(beforeStore + 1);
    expect(await eventSessions('page_view', vid)).toBe(1);
  });

  it('writes nothing, and does not throw, when there is nothing to write', async () => {
    const before = await storeUniques(KERAMIKA);
    await expect(recordPageViewTap({})).resolves.toBeUndefined();
    await expect(recordPageViewTap({ events: [], visitorId: 'x' })).resolves.toBeUndefined();
    expect(await storeUniques(KERAMIKA)).toBe(before);
  });
});

describe('it stays one round trip', () => {
  const read = (f: string) => readFileSync(f, 'utf8');

  it('the tap issues exactly one query', () => {
    // The whole reason this module exists. Two `query(` calls here and a page view is back to two
    // round trips, with every per-table test still passing.
    const src = read('src/lib/page-view-tap.ts');
    expect(src.match(/\bquery\(/g)).toHaveLength(1);
  });

  it('the two hot paths tap once and do not write around it', () => {
    // A later change is far more likely to ADD a `void recordAnalyticsEvent(...)` beside the tap
    // than to edit the tap itself — that is exactly how the four writes accumulated in the first
    // place, one reasonable line at a time.
    for (const file of ['src/middleware.ts', 'src/pages/api/store-product.ts']) {
      const src = read(file);
      expect(src.match(/recordPageViewTap\(/g), file).toHaveLength(1);
      expect(src, file).not.toMatch(/recordAnalyticsEvent\(|recordPageView\(|recordProductView\(/);
    }
  });
});
