/**
 * DB_MIGRATION_PLAN.md §9.5 — 50 concurrent purchases of a product with stock 10, and exactly 10
 * of them must succeed.
 *
 * **Why this could not be written before stage 3, and why it is not in the normal suite.** Every
 * other database test in this repo runs on PGlite, which is Postgres in ONE process: two "parallel"
 * decrements there are two calls into the same engine, so a race between two servers is precisely
 * the thing it cannot reproduce. §7.5's whole claim — that the conditional `UPDATE … WHERE stock >=
 * qty` needs no lock and stays correct on any number of servers — therefore had no test at all
 * until there was a real server to point at.
 *
 * **It skips itself unless `DATABASE_URL` is set**, which is how CI (no database) and every routine
 * `npm test` stay green while a developer or a pre-release check can run it for real:
 *
 *     DATABASE_URL="$(grep ^DATABASE_URL .env | cut -d= -f2-)" npx vitest run tests/stock-concurrency-live.test.ts
 *
 * **What it writes, and what it leaves behind: nothing.** It creates its own seller under
 * `@demo.local` — deliberately inside the disposable set the seeders' purge gate recognises, so a
 * run interrupted halfway is cleaned up by `npm run seed:demo -- --clean` like any other demo row —
 * and deletes it itself in `afterAll`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { closePool, query, setDatabase } from '../src/lib/db.js';
import { decrementStock, getProductById } from '../src/lib/store-products.js';

const LIVE = Boolean(process.env.DATABASE_URL);
const STOCK = 10;
const BUYERS = 50;

const sellerId = crypto.randomUUID();
const storeId = crypto.randomUUID();
const productId = crypto.randomUUID();

beforeAll(async () => {
  if (!LIVE) return;
  // Undo the PGlite instance `tests/helpers/db-setup.ts` installs for every file: this test is
  // about two connections racing, which is exactly what an in-process database cannot show.
  setDatabase(undefined);
  await query('INSERT INTO sellers (id, name, email) VALUES ($1, $2, $3)',
    [sellerId, 'concurrency probe', `concurrency-${sellerId}@demo.local`]);
  await query('INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, $4)',
    [storeId, sellerId, `concurrency-probe-${storeId}`, 'concurrency probe']);
  await query(
    'INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock) VALUES ($1, $2, $3, $4, $5, $6)',
    [productId, storeId, 'probe', 'probe', 1000, STOCK]);
});

afterAll(async () => {
  if (!LIVE) return;
  await query('DELETE FROM stores WHERE id = $1', [storeId]);
  await query('DELETE FROM sellers WHERE id = $1', [sellerId]);
  await closePool();
});

describe.skipIf(!LIVE)('§9.5 — concurrent stock decrement against a real server', () => {
  it(`lets exactly ${STOCK} of ${BUYERS} simultaneous buyers through, and never goes negative`, async () => {
    const results = await Promise.all(
      Array.from({ length: BUYERS }, () => decrementStock(productId, 1)),
    );

    const sold = results.filter((r) => r.ok);
    expect(sold).toHaveLength(STOCK);
    expect(results.filter((r) => !r.ok)).toHaveLength(BUYERS - STOCK);

    // Every winner claimed a DIFFERENT unit. Ten successes that all reported `after: 9` would mean
    // ten buyers were sold the same one — the oversell this statement exists to prevent, and the
    // count alone cannot see it.
    expect(new Set(sold.map((r) => r.after)).size).toBe(STOCK);
    expect(Math.min(...sold.map((r) => r.after))).toBe(0);

    const after = await getProductById(productId);
    expect(after!.stock).toBe(0);

    // A refusal reports the count that refused it, not a second read — so no loser may claim a
    // number that would have let the buyer's page offer stock that is gone.
    expect(results.filter((r) => !r.ok).every((r) => r.after === 0)).toBe(true);
  });
});
