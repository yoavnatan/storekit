/**
 * The gate that decides what a seeder is allowed to delete (`scripts/lib/seed-db.mjs`).
 *
 * **Why this file exists.** `purge()` used to accept a WHERE clause and run it. Both seeders passed
 * a predicate a real store cannot satisfy, so the behaviour was correct — but the SAFETY lived in
 * the callers, not in the function. A third caller, or one widened constant in either seeder, would
 * have deleted real stores, their whole catalogue and their orders with nothing in the way. Every
 * row in the database is seeded today, which is exactly why this had to close before the first real
 * seller, not after.
 *
 * The tests below are written so that **each layer of the gate has a test that fails when only that
 * layer is removed**:
 *   · "rejects a scope it does not know" fails if the name lookup goes away;
 *   · "refuses a widened scope" fails if the subset assertion goes away — it edits the scope
 *     constant the way a careless commit would, which the name lookup alone cannot catch;
 *   · "keeps an order shared with a real store" fails if the order purge goes back to matching on
 *     "touches a demo store" instead of "every store on it is disposable".
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  DEMO_EMAIL_SUFFIX,
  SEED_SCOPES,
  SHOWCASE_OWNER_EMAIL,
  purge,
  purgeOrdersOfStores,
} from '../scripts/lib/seed-db.mjs';
import { asDatabase, loadImage } from './helpers/test-db.js';

/**
 * A private database, emptied of the fixture: this file deletes stores and sellers wholesale, so it
 * must own every row it can see.
 *
 * **Loaded from the cached image, not built from the migrations — measured, twice.** Running the
 * migrations per test blew the 10s hook timeout under the full suite (8 workers sharing the CPU),
 * and moving it to a once-per-file `beforeAll` only made it one 15s hook instead of several. The
 * image is a disk read, which is why every other database test file uses it. Emptying it costs one
 * statement. The explicit hook timeout is the belt: a machine slower than this one must fail on an
 * assertion, not on a setup clock.
 */
let pg: PGlite;
let db: ReturnType<typeof asDatabase>;

beforeAll(async () => {
  pg = await loadImage();
  db = asDatabase(pg);
}, 30_000);
beforeEach(async () => {
  await db.query('TRUNCATE sellers, stores, orders, order_items, order_stores CASCADE');
});
afterAll(async () => { await pg?.close(); });

async function seller(email: string): Promise<string> {
  const id = randomUUID();
  await db.query('INSERT INTO sellers (id, email) VALUES ($1, $2)', [id, email]);
  return id;
}

async function store(sellerId: string, slug: string, demo = false): Promise<string> {
  const id = randomUUID();
  await db.query('INSERT INTO stores (id, seller_id, slug, name, demo) VALUES ($1, $2, $3, $4, $5)',
    [id, sellerId, slug, slug, demo]);
  return id;
}

/** An order with one `order_stores` row per slug — the shape a multi-store cart produces. */
async function order(slugs: string[]): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status)
     VALUES ($1, 'buyer', 'b@example.com', 1000, 'paid', 'pending')`, [id]);
  for (const slug of slugs) {
    await db.query('INSERT INTO order_stores (order_id, store_slug) VALUES ($1, $2)', [id, slug]);
  }
  return id;
}

const slugs = async (): Promise<string[]> => {
  const { rows } = await db.query<{ slug: string }>('SELECT slug::text AS slug FROM stores ORDER BY slug');
  return rows.map((r) => r.slug);
};
const emails = async (): Promise<string[]> => {
  const { rows } = await db.query<{ email: string }>('SELECT email::text AS email FROM sellers ORDER BY email');
  return rows.map((r) => r.email);
};

/** The three kinds of account the gate has to tell apart. */
async function threeWorlds() {
  const demoSeller = await seller(`seller1${DEMO_EMAIL_SUFFIX}`);
  const showcaseSeller = await seller(SHOWCASE_OWNER_EMAIL);
  const realSeller = await seller('rivka@keramika.co.il');
  await store(demoSeller, 'demo-shop');
  await store(showcaseSeller, 'showcase-shop', true);
  await store(realSeller, 'keramika');
  return { demoSeller, showcaseSeller, realSeller };
}

describe('the scopes delete their own set and nothing else', () => {
  it('demo removes the demo stores and accounts, and leaves showcase and real alone', async () => {
    await threeWorlds();

    const removed = await purge(db, 'demo');

    expect(removed).toEqual({ stores: 1, sellers: 1 });
    expect(await slugs()).toEqual(['keramika', 'showcase-shop']);
    expect(new Set(await emails())).toEqual(new Set([SHOWCASE_OWNER_EMAIL, 'rivka@keramika.co.il']));
  });

  it('showcase removes the showcase set, and leaves demo and real alone', async () => {
    await threeWorlds();

    const removed = await purge(db, 'showcase');

    expect(removed).toEqual({ stores: 1, sellers: 1 });
    expect(await slugs()).toEqual(['demo-shop', 'keramika']);
    expect(new Set(await emails())).toEqual(new Set([`seller1${DEMO_EMAIL_SUFFIX}`, 'rivka@keramika.co.il']));
  });

  it('keeps the accounts when told to — what a re-seed reusing the same owner row needs', async () => {
    await threeWorlds();

    const removed = await purge(db, 'showcase', { includeSellers: false });

    expect(removed).toEqual({ stores: 1, sellers: 0 });
    expect(await emails()).toHaveLength(3);
  });

  it('a store flagged demo is disposable even under a real account — the flag is the showcase mark', async () => {
    const realSeller = await seller('rivka@keramika.co.il');
    await store(realSeller, 'keramika');
    await store(realSeller, 'showcase-borrowed', true);

    await purge(db, 'showcase', { includeSellers: false });

    expect(await slugs()).toEqual(['keramika']);
  });
});

describe('layer 1 — a caller names a scope, it does not write one', () => {
  it('rejects a scope it does not know, and deletes nothing', async () => {
    await threeWorlds();

    // The shape the old signature accepted: arbitrary SQL straight into a DELETE.
    await expect(purge(db, { storeWhere: '1 = 1' } as never)).rejects.toThrow(/unknown scope/);
    await expect(purge(db, 'DEMO' as never)).rejects.toThrow(/unknown scope/);
    await expect(purgeOrdersOfStores(db, 'everything' as never)).rejects.toThrow(/unknown scope/);

    expect(await slugs()).toHaveLength(3);
    expect(await emails()).toHaveLength(3);
  });

  /**
   * The runtime gate only protects a caller that goes THROUGH `purge`. Nothing stops a new script
   * from writing its own `DELETE FROM stores` and reaching the same rows with none of it — which is
   * the identical shape of hole this whole change closes, one level up. So the rule is grepped, the
   * way `safe-redirect` and `email-address` are: `scripts/` deletes accounts, stores and orders only
   * via `seed-db.mjs`.
   */
  it('no script deletes an account, store or order except through seed-db.mjs', () => {
    const dir = path.join(process.cwd(), 'scripts');
    const files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('seed-db.mjs'));

    const offenders = files.filter((f) => /DELETE\s+FROM\s+(stores|sellers|orders|order_items|order_stores)\b/i
      .test(fs.readFileSync(path.join(dir, f), 'utf8')));

    expect(offenders).toEqual([]);
  });
});

describe('layer 2 — a scope may only ever narrow the disposable set', () => {
  /** Restores whatever the previous test widened — a widened scope must not leak between cases. */
  const original = { ...SEED_SCOPES.demo };
  beforeEach(() => { Object.assign(SEED_SCOPES.demo, original); });
  afterAll(() => { Object.assign(SEED_SCOPES.demo, original); });

  it('refuses a widened scope before deleting anything, and names the count', async () => {
    await threeWorlds();
    // Exactly the accident this layer exists for: the name lookup still passes, the predicate no
    // longer describes seeded data. `TRUE` is the blunt version; a real one would be a dropped
    // `NOT`, or an email constant edited to something a real seller could hold.
    SEED_SCOPES.demo.stores = 'TRUE';

    // One of the three: the demo store and the `demo = true` showcase one are both disposable.
    await expect(purge(db, 'demo')).rejects.toThrow(/purge refused: 1 row\(s\) in "stores"/);

    expect(await slugs()).toHaveLength(3);
    expect(await emails()).toHaveLength(3);
  });

  it('refuses a widened SELLER scope too — an account is deleted by its own clause', async () => {
    await threeWorlds();
    SEED_SCOPES.demo.sellers = "email LIKE '%'";

    await expect(purge(db, 'demo')).rejects.toThrow(/purge refused: 1 row\(s\) in "sellers"/);

    // The store DELETE runs first and its own scope was untouched, so the check that mattered is
    // that the accounts survived: the refusal has to come BEFORE the sellers statement.
    expect(await emails()).toHaveLength(3);
  });

  it('does not check the seller clause when the sellers are being kept', async () => {
    await threeWorlds();
    SEED_SCOPES.demo.sellers = "email LIKE '%'";

    await expect(purge(db, 'demo', { includeSellers: false })).resolves.toEqual({ stores: 1, sellers: 0 });
  });
});

describe('orders — deleted only when every store on them is disposable', () => {
  it('removes a demo-only order with its lines', async () => {
    const { demoSeller } = await threeWorlds();
    await store(demoSeller, 'demo-shop-2');
    const id = await order(['demo-shop', 'demo-shop-2']);

    expect(await purgeOrdersOfStores(db, 'demo')).toEqual({ deleted: 1, keptShared: 0 });

    const { rows } = await db.query('SELECT id FROM orders WHERE id = $1', [id]);
    expect(rows).toHaveLength(0);
    const { rows: lines } = await db.query('SELECT order_id FROM order_stores');
    expect(lines).toHaveLength(0);
  });

  it('keeps an order shared with a real store, and reports it', async () => {
    await threeWorlds();
    const shared = await order(['demo-shop', 'keramika']);

    expect(await purgeOrdersOfStores(db, 'demo')).toEqual({ deleted: 0, keptShared: 1 });

    const { rows } = await db.query('SELECT id FROM orders WHERE id = $1', [shared]);
    expect(rows).toHaveLength(1);
  });

  it('treats a slug no store answers to as NOT disposable — a deleted store cannot prove it was seeded', async () => {
    await threeWorlds();
    await order(['demo-shop', 'store-that-was-deleted']);

    expect(await purgeOrdersOfStores(db, 'demo')).toEqual({ deleted: 0, keptShared: 1 });
  });

  it('a demo order and a shared one in the same run: one goes, one stays', async () => {
    const { demoSeller } = await threeWorlds();
    await store(demoSeller, 'demo-shop-2');
    const alone = await order(['demo-shop-2']);
    const shared = await order(['demo-shop', 'keramika']);

    expect(await purgeOrdersOfStores(db, 'demo')).toEqual({ deleted: 1, keptShared: 1 });

    const { rows } = await db.query<{ id: string }>('SELECT id FROM orders');
    expect(rows.map((r) => r.id)).toEqual([shared]);
    expect(rows.map((r) => r.id)).not.toContain(alone);
  });

  it('ignores orders that touch no store in the scope at all', async () => {
    await threeWorlds();
    await order(['keramika']);

    expect(await purgeOrdersOfStores(db, 'demo')).toEqual({ deleted: 0, keptShared: 0 });
  });
});
