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
  RETURN_DEMO_PAYMENT_REF,
  SEED_SCOPES,
  SHOWCASE_OWNER_EMAIL,
  purge,
  purgeOrdersOfStores,
  purgeReturnDemo,
} from '../scripts/lib/seed-db.mjs';
import { sweep } from '../scripts/sweep-visitor-content.mjs';
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

    // `return_requests` and `seller_ledger_adjustments` joined the list on 2026-08-20, when
    // `seed-returns.mjs` made both reachable from seeded data: the first blocks an order delete
    // outright (RESTRICT), the second survives one and goes on deducting from a real payout.
    const offenders = files.filter((f) => /DELETE\s+FROM\s+(stores|sellers|orders|order_items|order_stores|return_requests|seller_ledger_adjustments)\b/i
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

    expect(await purgeOrdersOfStores(db, 'demo')).toEqual({ deleted: 1, keptShared: 0, journalRows: 0 });

    const { rows } = await db.query('SELECT id FROM orders WHERE id = $1', [id]);
    expect(rows).toHaveLength(0);
    const { rows: lines } = await db.query('SELECT order_id FROM order_stores');
    expect(lines).toHaveLength(0);
  });

  it('keeps an order shared with a real store, and reports it', async () => {
    await threeWorlds();
    const shared = await order(['demo-shop', 'keramika']);

    expect(await purgeOrdersOfStores(db, 'demo')).toEqual({ deleted: 0, keptShared: 1, journalRows: 0 });

    const { rows } = await db.query('SELECT id FROM orders WHERE id = $1', [shared]);
    expect(rows).toHaveLength(1);
  });

  it('treats a slug no store answers to as NOT disposable — a deleted store cannot prove it was seeded', async () => {
    await threeWorlds();
    await order(['demo-shop', 'store-that-was-deleted']);

    expect(await purgeOrdersOfStores(db, 'demo')).toEqual({ deleted: 0, keptShared: 1, journalRows: 0 });
  });

  it('a demo order and a shared one in the same run: one goes, one stays', async () => {
    const { demoSeller } = await threeWorlds();
    await store(demoSeller, 'demo-shop-2');
    const alone = await order(['demo-shop-2']);
    const shared = await order(['demo-shop', 'keramika']);

    expect(await purgeOrdersOfStores(db, 'demo')).toEqual({ deleted: 1, keptShared: 1, journalRows: 0 });

    const { rows } = await db.query<{ id: string }>('SELECT id FROM orders');
    expect(rows.map((r) => r.id)).toEqual([shared]);
    expect(rows.map((r) => r.id)).not.toContain(alone);
  });

  it('ignores orders that touch no store in the scope at all', async () => {
    await threeWorlds();
    await order(['keramika']);

    expect(await purgeOrdersOfStores(db, 'demo')).toEqual({ deleted: 0, keptShared: 0, journalRows: 0 });
  });
});

/**
 * The rows a purge has to take WITH the order, and the two different reasons.
 *
 * `return_requests` references `orders` with `ON DELETE RESTRICT`, so leaving it behind breaks the
 * purge itself — loudly, but with a Postgres constraint name rather than anything a person can act
 * on. `seller_ledger_adjustments` and `invoice_documents` reference it with `ON DELETE SET NULL`,
 * so leaving them behind breaks nothing and is worse: the row survives with no order to explain it
 * and goes on deducting from a seller's next payout, on a dashboard read as true.
 *
 * Both became reachable on 2026-08-20 with `seed-returns.mjs` — a staged case that the owner then
 * REFUNDS runs the real `moveReturnRequest`, which writes exactly these rows.
 */
describe('a purge takes an order\u2019s money rows with it', () => {
  async function orderWithMoneyTrail(slug: string, paymentRef: string | null): Promise<string> {
    const sellerId = await seller(`ledger${DEMO_EMAIL_SUFFIX}`);
    await store(sellerId, slug);
    const orderId = randomUUID();
    await db.query(
      `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status, payment_ref)
       VALUES ($1, 'buyer', 'b@example.com', 1000, 'paid', 'delivered', $2)`, [orderId, paymentRef]);
    await db.query('INSERT INTO order_stores (order_id, store_slug) VALUES ($1, $2)', [orderId, slug]);
    await db.query(
      `INSERT INTO return_requests (id, order_id, store_slug, reason, status, within_statutory, refund_agorot)
       VALUES ($1, $2, $3, 'damaged', 'refunded', true, 1000)`, [randomUUID(), orderId, slug]);
    await db.query(
      `INSERT INTO seller_ledger_adjustments (seller_id, order_id, kind, amount_agorot, detail)
       VALUES ($1, $2, 'refund_clawback', -900, 'staged')`, [sellerId, orderId]);
    return orderId;
  }

  const survivors = async (): Promise<{ requests: number; adjustments: number }> => {
    const rr = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM return_requests');
    const adj = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM seller_ledger_adjustments');
    return { requests: Number(rr.rows[0]!.n), adjustments: Number(adj.rows[0]!.n) };
  };

  it('purgeOrdersOfStores clears the return AND the clawback, not just the order', async () => {
    await orderWithMoneyTrail('demo-shop', 'MOCK-1');

    const removed = await purgeOrdersOfStores(db, 'demo');

    expect(removed.deleted).toBe(1);
    expect(await survivors()).toEqual({ requests: 0, adjustments: 0 });
  });

  it('purgeReturnDemo does the same for a staged scenario, matched by its payment_ref', async () => {
    await orderWithMoneyTrail('demo-shop', `${RETURN_DEMO_PAYMENT_REF}0`);

    const removed = await purgeReturnDemo(db);

    expect(removed).toEqual({ orders: 1, requests: 1 });
    expect(await survivors()).toEqual({ requests: 0, adjustments: 0 });
  });

  it('leaves an order that carries no staged mark completely alone', async () => {
    await orderWithMoneyTrail('demo-shop', 'MOCK-REAL');

    expect(await purgeReturnDemo(db)).toEqual({ orders: 0, requests: 0 });
    expect(await survivors()).toEqual({ requests: 1, adjustments: 1 });
  });
});

/**
 * The `visitor` scope — the sweep that keeps the demonstration curated.
 *
 * **The requirement it serves, and the one it must not break.** Anybody may press "פתח חנות" on the
 * demonstration and build a real shop; a month of that and the four curated stores sit among thirty
 * called "test". But the owner edits the showcase shops through the dashboard, which is why the
 * hourly rebuild had to be turned off — so a sweep that reaches them is worse than no sweep at all
 * (owner, 2026-08-27: what other people make is temporary, what he edits stays).
 *
 * Both halves are asserted below, and so is the third thing that would quietly break the exhibit:
 * the seeded `@demo.local` cast must SURVIVE. `portfolio` deletes those accounts because a re-seed
 * recreates them a second later; this scope runs alone on a timer, and taking them would leave
 * every seeded order without the person who placed it.
 */
describe('the visitor scope', () => {
  /** The claim row the scope is gated on — written by `demo:claim` in real life. Removed before
   *  each case, because the file's own TRUNCATE does not reach `app_settings` and a claim left
   *  standing would make the two refusal cases pass for the wrong reason. */
  const claim = (): Promise<unknown> => db.query(
    "INSERT INTO app_settings (key, value) VALUES ('demo_database', 'true') ON CONFLICT (key) DO NOTHING");

  /** Backdate a row, which is the only thing this scope keys on besides ownership. */
  const age = (table: 'stores' | 'sellers', ident: string, hours: number): Promise<unknown> =>
    db.query(`UPDATE ${table} SET created_at = now() - ($1 || ' hours')::interval
              WHERE ${table === 'stores' ? 'slug::text' : 'email::text'} = $2`, [String(hours), ident]);

  beforeEach(async () => {
    await db.query("DELETE FROM app_settings WHERE key = 'demo_database'");
  });

  it('takes a visitor shop that has gone cold, and leaves everything else standing', async () => {
    await claim();
    await threeWorlds();
    await store(await seller('someone@gmail.com'), 'abandoned-test-shop');
    await age('stores', 'abandoned-test-shop', 48);
    await age('sellers', 'someone@gmail.com', 48);

    const removed = await purge(db, 'visitor');

    expect(removed).toEqual({ stores: 1, sellers: 1 });
    expect(await slugs()).toEqual(['demo-shop', 'keramika', 'showcase-shop']);
  });

  it('leaves a shop still inside its day — somebody may be building it right now', async () => {
    await claim();
    await store(await seller('someone@gmail.com'), 'built-this-morning');
    await age('stores', 'built-this-morning', 3);
    await age('sellers', 'someone@gmail.com', 3);

    expect(await purge(db, 'visitor')).toEqual({ stores: 0, sellers: 0 });
    expect(await slugs()).toEqual(['built-this-morning']);
  });

  it("never takes a showcase shop, however old it is — that is the owner's own work", async () => {
    await claim();
    await store(await seller(SHOWCASE_OWNER_EMAIL), 'showcase-tech', true);
    await age('stores', 'showcase-tech', 24 * 365);
    await age('sellers', SHOWCASE_OWNER_EMAIL, 24 * 365);

    expect(await purge(db, 'visitor')).toEqual({ stores: 0, sellers: 0 });
    expect(await slugs()).toEqual(['showcase-tech']);
  });

  it('keeps the seeded @demo.local cast, which the portfolio scope would have taken', async () => {
    await claim();
    await seller(`buyer7${DEMO_EMAIL_SUFFIX}`);
    await age('sellers', `buyer7${DEMO_EMAIL_SUFFIX}`, 24 * 90);

    await purge(db, 'visitor');

    expect(await emails()).toEqual([`buyer7${DEMO_EMAIL_SUFFIX}`]);
  });

  it('refuses entirely on a database that has not claimed itself the demonstration', async () => {
    // The only thing between this scope and somebody's development database — every ordinary
    // database is in exactly this state, so the refusal is the common case and not the edge one.
    await store(await seller('someone@gmail.com'), 'abandoned-test-shop');
    await age('stores', 'abandoned-test-shop', 48);

    await expect(purge(db, 'visitor')).rejects.toThrow(/has not been claimed/);
    expect(await slugs()).toEqual(['abandoned-test-shop']);
  });

  it('refuses the ORDER sweep on an unclaimed database too, not only the store one', async () => {
    // Two entry points, two gates. `purgeOrdersOfStores` runs first in the sweep script, so a gate
    // on `purge` alone would let it delete a development database's orders before anything refused.
    await expect(purgeOrdersOfStores(db, 'visitor')).rejects.toThrow(/has not been claimed/);
  });

  it('and the script the job actually runs does all of it in one call', async () => {
    // The cases above drive the SCOPE; this one drives `sweep()` itself, which is what the
    // `demo-sweep` job shells out to. Without it the scope could be perfect and the runner could
    // call it in the wrong order — orders after stores, which strands every order on a slug
    // nothing answers to — and every test above would still be green.
    await claim();
    await threeWorlds();
    await store(await seller('someone@gmail.com'), 'abandoned-test-shop');
    await order(['abandoned-test-shop']);
    await order(['showcase-shop']);
    await age('stores', 'abandoned-test-shop', 48);
    await age('sellers', 'someone@gmail.com', 48);

    const result = await sweep(db);

    expect(result).toMatchObject({ stores: 1, sellers: 1, orders: 1 });
    expect(await slugs()).toEqual(['demo-shop', 'keramika', 'showcase-shop']);
    const left = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM orders');
    expect(left.rows[0]!.n).toBe('1');
  });
});
