/**
 * The schema and the import script, executed for real against the repo's own `data/*.json`.
 *
 * **Why this can run with no database installed.** PGlite is Postgres itself compiled to WASM and
 * run in-process — the same parser, planner and constraint machinery, not an emulation. So a
 * `CREATE TABLE` that Postgres would reject fails here, a foreign key that would be violated is
 * violated here, and `citext`/`pg_trgm` behave as they do in production. That matters because the
 * alternative — "the migration looks right" — is exactly how §7.1's global unique constraint and
 * §7.12's NULL flags would have shipped: both fail on the first row of the real data, and neither
 * is visible by reading.
 *
 * What this does NOT cover: connection pooling, concurrency, and `EXPLAIN ANALYZE` on the hot
 * queries (§9.2/§9.5) — those need a server and belong to the local docker Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { importAll, toAgorot } from '../scripts/lib/db-import.mjs';
import { verifyImport } from '../scripts/lib/verify-import.mjs';
import { roundMoney } from '../src/lib/money.js';

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, 'migrations');
const FIXTURE = path.join(ROOT, 'tests/fixtures/db-data');
// Overridable so the CI condition (an empty `data/`) can be reproduced on a dev machine by
// pointing this at an empty directory, rather than by moving the live files out from under a
// running dev server.
const LIVE_DATA = process.env.STOREKIT_LIVE_DATA_DIR || path.join(ROOT, 'data');

let db: PGlite;
let dataDir: string;
let report: ImportReport;

type ImportReport = { counts: Record<string, number>; skipped: { what: string; reason: string; count: number }[] };

/**
 * `data/*.json` is gitignored — it is runtime state, and it holds real buyer names and addresses,
 * so it can never be committed. CI therefore has an EMPTY `data/`, and a suite written against it
 * alone imported nothing there and failed five ways.
 *
 * The fix is not to skip the suite when the files are missing: an import nobody verifies on the
 * one machine that runs every push is an import nobody verifies. `tests/fixtures/db-data/` is a
 * committed dataset that carries the same traps the real data taught us — §7.1's cross-store slug
 * collision, §7.12's absent flags, §7.3's two bucket shapes in one file, §7.7's binary tail,
 * §7.11's case-only duplicate email, a wishlist entry naming a product that is not in the
 * catalogue, and one orphan of every kind so the drop paths are exercised. It found three wrong
 * anchors in verify-import.mjs within a minute of first running.
 *
 * The real data still gets imported below when it is present, because a fixture only ever contains
 * the traps someone thought of.
 */
function migrationSql(): string[] {
  return fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort().map((name) =>
    fs.readFileSync(path.join(MIGRATIONS, name), 'utf8')
      // pgvector is not bundled with PGlite. It is created in the migration deliberately (a
      // provider that cannot run that line is the wrong provider — DB_MIGRATION_PLAN.md §2.1), and
      // nothing in the schema depends on it yet, so the ONLY line this test skips is that one.
      .replace(/^CREATE EXTENSION IF NOT EXISTS vector;$/m, ''));
}

async function freshDb(): Promise<PGlite> {
  const created = await PGlite.create({ extensions: { citext, pg_trgm } });
  for (const sql of migrationSql()) await created.exec(sql);
  return created;
}

/**
 * The import and the checks both read the JSON, and every check compares one against the other —
 * so the files must not move underneath them. `data/` is live: a running dev server records a page
 * view on every request, and other test files write to it too. A one-time snapshot is what makes
 * the comparison meaningful rather than a race.
 */
function snapshot(src: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storekit-db-'));
  for (const name of fs.readdirSync(src).filter((f) => f.endsWith('.json'))) {
    fs.copyFileSync(path.join(src, name), path.join(dir, name));
  }
  return dir;
}

/** Whether a real `data/` is present — true on a dev machine, false in CI. */
function hasLiveData(): boolean {
  try { return fs.readdirSync(LIVE_DATA).some((f) => f.endsWith('.json')); } catch { return false; }
}

beforeAll(async () => {
  dataDir = snapshot(FIXTURE);
  db = await freshDb();
  report = await importAll(db, { dataDir });
}, 120_000);

afterAll(async () => {
  await db?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('schema', () => {
  it('creates every table the import writes to', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tables = new Set(rows.map((r) => r.table_name));
    for (const table of Object.keys(report.counts)) expect(tables.has(table)).toBe(true);
  });

  it('has no nullable boolean flag anywhere (§7.12 — the silent-disappearance bug)', async () => {
    // The rule is enforced at the column level rather than trusted to the import, so that a future
    // ALTER cannot reintroduce it either.
    const { rows } = await db.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'boolean' AND is_nullable = 'YES'
    `);
    expect(rows).toEqual([]);
  });

  it('scopes product slug uniqueness to the store, not globally (§7.1)', async () => {
    const store = (await db.query<{ id: string }>('SELECT id FROM stores LIMIT 1')).rows[0];
    const other = (await db.query<{ id: string }>('SELECT id FROM stores OFFSET 1 LIMIT 1')).rows[0];
    const insert = (storeId: string, id: string) =>
      db.query(
        `INSERT INTO store_products (id, store_id, slug, name, price_agorot) VALUES ($1,$2,'dup-slug-check','x',100)`,
        [id, storeId],
      );
    await insert(store.id, '11111111-1111-4111-8111-111111111111');
    // Same slug in a DIFFERENT store must be allowed — 47 such pairs exist in the real data.
    await expect(insert(other.id, '22222222-2222-4222-8222-222222222222')).resolves.toBeTruthy();
    // Same slug in the SAME store must not.
    await expect(insert(store.id, '33333333-3333-4333-8333-333333333333')).rejects.toThrow();
    await db.query(`DELETE FROM store_products WHERE slug = 'dup-slug-check'`);
  });

  it('rejects a second order carrying the same payment reference (§7.6)', async () => {
    const row = ['44444444-4444-4444-8444-444444444444', 'A', 'a@b.c', 1000, 'pending', 'pending', 'ref-dup-check'];
    const insert = (id: string) => db.query(
      `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status, payment_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, ...row.slice(1)],
    );
    await insert(row[0] as string);
    await expect(insert('55555555-5555-4555-8555-555555555555')).rejects.toThrow();
    await db.query(`DELETE FROM orders WHERE payment_ref = 'ref-dup-check'`);
  });

  it('decrements variant stock atomically and refuses to go negative (§7.5 — what replaces mutex.ts)', async () => {
    const product = (await db.query<{ id: string }>('SELECT id FROM store_products LIMIT 1')).rows[0];
    await db.query(`INSERT INTO product_variant_stock (product_id, combo_key, stock) VALUES ($1,'atomic-check',10)`, [product.id]);
    const take = (qty: number) => db.query(
      `UPDATE product_variant_stock SET stock = stock - $3
       WHERE product_id = $1 AND combo_key = $2 AND stock >= $3`,
      [product.id, 'atomic-check', qty],
    );
    // The affected-row count IS the answer: 1 = sold, 0 = reject. No lock, correct on any number
    // of servers — this is the property that lets `lib/mutex.ts` be deleted.
    expect((await take(4)).affectedRows).toBe(1);
    expect((await take(4)).affectedRows).toBe(1);
    expect((await take(4)).affectedRows).toBe(0);
    const left = (await db.query<{ stock: number }>(
      `SELECT stock FROM product_variant_stock WHERE product_id = $1 AND combo_key = 'atomic-check'`, [product.id])).rows[0];
    expect(left.stock).toBe(2);
    await db.query(`DELETE FROM product_variant_stock WHERE combo_key = 'atomic-check'`);
  });

  it('replays rather than duplicates a repeated checkout key (§4 checkout_idempotency)', async () => {
    const first = await db.query(
      `INSERT INTO checkout_idempotency (key, status) VALUES ('k-dup','pending') ON CONFLICT DO NOTHING`);
    const second = await db.query(
      `INSERT INTO checkout_idempotency (key, status) VALUES ('k-dup','pending') ON CONFLICT DO NOTHING`);
    expect(first.affectedRows).toBe(1);
    expect(second.affectedRows).toBe(0);   // the second request charges nothing and replays
    await db.query(`DELETE FROM checkout_idempotency WHERE key = 'k-dup'`);
  });

  it('treats store slugs case-insensitively (§7.11 citext)', async () => {
    const slug = (await db.query<{ slug: string }>('SELECT slug FROM stores LIMIT 1')).rows[0].slug;
    const { rows } = await db.query('SELECT id FROM stores WHERE slug = $1', [slug.toUpperCase()]);
    expect(rows).toHaveLength(1);
  });

  it('never cascades a delete into an order (§7.9 — orders are financial records)', async () => {
    const { rows } = await db.query<{ table_name: string; delete_rule: string }>(`
      SELECT tc.table_name, rc.delete_rule
      FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
      WHERE tc.table_name IN ('order_items', 'order_stores')
    `);
    expect(rows.length).toBeGreaterThan(0);
    // RESTRICT / NO ACTION both refuse; CASCADE or SET NULL would let deleting a store or a
    // product erase the record of what was sold.
    for (const r of rows) expect(['RESTRICT', 'NO ACTION']).toContain(r.delete_rule);
  });
});

/** Every amount in a dataset, for the agorot conversion check. */
function everyAmount(dir: string): number[] {
  const orders = JSON.parse(fs.readFileSync(path.join(dir, 'orders.json'), 'utf8'));
  const products = JSON.parse(fs.readFileSync(path.join(dir, 'store-products.json'), 'utf8'));
  return [
    ...orders.flatMap((o: { totalAmount: number; shippingAmount: number; items?: { price: number }[] }) =>
      [o.totalAmount, o.shippingAmount, ...(o.items ?? []).map((i) => i.price)]),
    ...products.map((p: { price: number }) => p.price),
  ].filter((n: number) => Number.isFinite(n));
}

describe('import of the fixture data', () => {
  it('passes every §9 verification check', async () => {
    const checks = await verifyImport(db, { dataDir, skipped: report.skipped });
    const failed = checks.filter((c) => !c.ok);
    expect(
      failed.map((c) => `${c.name}: expected ${c.expected}, got ${c.actual}`),
    ).toEqual([]);
    expect(checks.length).toBeGreaterThan(20);
  });

  it('drops exactly the orphans the fixture plants, and no more', async () => {
    // The fixture carries one unusable row of each kind on purpose. Asserting the exact set is
    // what stops a future change from quietly dropping something real: a drop count that grows is
    // supposed to fail here rather than be absorbed into an anchor.
    const byWhat = Object.fromEntries(report.skipped.map((s) => [s.what, s.count]));
    expect(byWhat).toEqual({
      seller: 1,                  // §7.11 — same address as another, differing only in case
      store: 1,                   // owner account is not in sellers.json
      category: 1,                // store is not in stores.json
      product: 1,                 // store is not in stores.json
      'admin message': 1,         // seller account is not in sellers.json
      'ad campaign': 1,           // store is not in stores.json
      'store page-views': 1,      // bucket for a store that never landed
      'product page-views': 1,    // bucket for a product that has been deleted
      'wishlist item': 1,         // names a product that is not in the catalogue
      'favourite store': 1,       // names a store that is not in stores.json
    });
  });

  it('converts to agorot by the same rule money.ts rounds by (§7.7)', () => {
    // The §9 money checks compare the database against `toAgorot` — which proves nothing was lost
    // in transit, but not that the conversion itself matches what the application has been
    // showing all along. This is that second half: a binary tail like 1.00499999999999989 rounds
    // one way with the EPSILON nudge and the other way without it, and one agora of drift per row
    // is not something anyone would notice by reading.
    const amounts = everyAmount(dataDir);
    expect(amounts).toContain(1.005);   // the fixture must keep carrying a binary tail
    for (const amount of amounts) expect(toAgorot(amount)).toBe(Math.round(roundMoney(amount) * 100));
  });

  it('is re-runnable — a second import writes nothing new', async () => {
    const before = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM store_products');
    await importAll(db, { dataDir });
    const after = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM store_products');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('refreshes a counter on re-import instead of leaving it stale (§7.15)', async () => {
    // Row tables are facts and a repeat insert must do nothing. COUNTERS are not: the JSON keeps
    // moving while the import is being iterated on (a running dev server records a page view on
    // every request), and `DO NOTHING` froze every existing day at its first-run value — a
    // shortfall that shows up as a slightly quiet week, never as an error.
    const day = (await db.query<{ day: string; event: string }>(
      'SELECT day, event FROM analytics_daily LIMIT 1')).rows[0];
    const before = (await db.query<{ count: number }>(
      'SELECT count FROM analytics_daily WHERE day = $1 AND event = $2', [day.day, day.event])).rows[0].count;

    await db.query('UPDATE analytics_daily SET count = 1 WHERE day = $1 AND event = $2', [day.day, day.event]);
    await importAll(db, { dataDir });

    const after = (await db.query<{ count: number }>(
      'SELECT count FROM analytics_daily WHERE day = $1 AND event = $2', [day.day, day.event])).rows[0].count;
    expect(after).toBe(before);
  });

  it('reports every row it could not write instead of dropping it silently (§7.15)', async () => {
    // The real data contains page-view buckets for products that have since been deleted. The
    // import must account for them out loud; a silent shortfall reads as "a quiet week".
    for (const s of report.skipped) {
      expect(s.reason).toBeTruthy();
      expect(s.count).toBeGreaterThan(0);
    }
  });
});

/**
 * The same import over the REAL `data/*.json`, which exists on a dev machine and not in CI.
 *
 * A fixture only ever contains the traps someone thought of, and every §7 rule in the plan came
 * from a surprise in these files rather than from reasoning — so this half stays. It is skipped
 * rather than failed where the files are absent, which is honest only because the fixture above
 * runs everywhere: if this were the only coverage, CI would be verifying nothing while reporting
 * a pass.
 */
describe.skipIf(!hasLiveData())('import of the real data/*.json (dev machines only)', () => {
  let liveDb: PGlite;
  let liveDir: string;
  let liveReport: ImportReport;

  beforeAll(async () => {
    liveDir = snapshot(LIVE_DATA);
    liveDb = await freshDb();
    liveReport = await importAll(liveDb, { dataDir: liveDir });
  }, 120_000);

  afterAll(async () => {
    await liveDb?.close();
    if (liveDir) fs.rmSync(liveDir, { recursive: true, force: true });
  });

  it('passes every §9 verification check on the real files', async () => {
    const checks = await verifyImport(liveDb, { dataDir: liveDir, skipped: liveReport.skipped });
    const failed = checks.filter((c) => !c.ok);
    expect(
      failed.map((c) => `${c.name}: expected ${c.expected}, got ${c.actual}`),
    ).toEqual([]);
  });

  it('converts every real amount by the same rule money.ts rounds by (§7.7)', () => {
    const amounts = everyAmount(liveDir);
    expect(amounts.length).toBeGreaterThan(500);
    for (const amount of amounts) expect(toAgorot(amount)).toBe(Math.round(roundMoney(amount) * 100));
  });
});
