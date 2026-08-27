import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { query, getDatabase } from '../src/lib/db.js';
import { DEMO_BUYER_EMAIL, DEMO_SELLER_EMAIL } from '../src/lib/demo-mode.js';
import { GUEST_SENDER_PREFIX } from '../src/lib/guest-sender.js';
// The seeder is plain Node with no types; `allowJs` resolves it, and driving the real functions
// against the real schema is the whole point of this file.
import { buildTrading, seedClearing, claim, purgeEverythingButShowcase } from '../scripts/seed-portfolio.mjs';
import { isDemoDatabase, purge, purgeOrdersOfStores } from '../scripts/lib/seed-db.mjs';

/**
 * The portfolio seeder, against the real schema.
 *
 * **The reason this file exists is the DELETE.** `seed:portfolio` removes every store that is not a
 * showcase store, and the only thing standing between that statement and somebody's development
 * database is the claim gate. A guard nobody has watched refuse is not a guard
 * (`feedback_guards_must_be_proved_to_fail`), so the first block below makes it refuse.
 *
 * The rest asserts the invariants a demonstration is judged on, which are not the same as the ones
 * a test suite usually checks. Nobody will notice a missing column; everybody notices an order
 * placed yesterday that is already delivered, a five-star average with no distribution bar, or a
 * revenue figure that disagrees with the order list beside it. Those are the assertions here.
 *
 * PGlite gives the real Postgres parser, planner and constraints, so a column list that does not
 * match the schema fails here rather than on the demo host.
 */

const SELLER = '88888888-8888-4888-8888-000000000001';
const STORE = '88888888-8888-4888-8888-000000000002';

/** Re-runnable, like the real showcase seeder: it reuses the platform account rather than
 *  recreating it, which is what lets the purge keep that row and the seed run again on top. */
async function seedOneShowcaseStore(): Promise<void> {
  await query('INSERT INTO sellers (id, name, email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [SELLER, 'Showcase', DEMO_SELLER_EMAIL]);
  await query(
    `INSERT INTO stores (id, seller_id, slug, name, demo) VALUES ($1, $2, 'showcase-test', 'חנות בדיקה', false)
       ON CONFLICT DO NOTHING`,
    [STORE, SELLER],
  );
  for (let i = 0; i < 12; i++) {
    const id = `88888888-8888-4888-8888-1000000000${String(i).padStart(2, '0')}`;
    await query(
      `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock)
            VALUES ($1, $2, $3, $4, $5, 50) ON CONFLICT DO NOTHING`,
      [id, STORE, `p-${i}`, `מוצר ${i}`, 4900 + i * 1100],
    );
    await query('INSERT INTO product_images (product_id, position, url) VALUES ($1, 0, $2) ON CONFLICT DO NOTHING',
      [id, `https://example.invalid/${i}.jpg`]);
  }
}

beforeEach(async () => {
  for (const t of ['product_reviews', 'money_events', 'order_items', 'order_stores', 'orders',
    'ad_campaigns', 'notifications', 'store_page_views', 'product_page_views',
    'seller_subscriptions', 'seller_merchant_accounts', 'product_images', 'store_products', 'stores']) {
    await query(`DELETE FROM ${t}`);
  }
  await query('DELETE FROM sellers');
  await query('DELETE FROM app_settings WHERE key = $1', ['demo_database']);
});

describe('the claim gate — the only thing between the DELETE and a real database', () => {
  it('refuses to claim a database holding a store no seeder made', async () => {
    await query('INSERT INTO sellers (id, name, email) VALUES ($1, $2, $3)', [SELLER, 'Real', 'real@example.com']);
    await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, 'real-shop', 'חנות אמיתית')`, [STORE, SELLER]);

    // `claim` calls process.exit(1) on refusal, which is right for a script and unusable in a test.
    // Intercepted rather than refactored: the exit IS the behaviour being asserted — a claim that
    // merely logged and carried on would leave the database marked disposable.
    const realExit = process.exit;
    let exited: number | undefined;
    process.exit = (code?: number) => { exited = code; throw new Error('exit'); };
    try { await claim(getDatabase()); } catch { /* the stub's throw */ }
    process.exit = realExit;

    expect(exited).toBe(1);
    expect(await isDemoDatabase(getDatabase())).toBe(false);
  });

  it('claims a database that holds only seeded data', async () => {
    await seedOneShowcaseStore();
    await claim(getDatabase());
    expect(await isDemoDatabase(getDatabase())).toBe(true);
  });
});

describe('what the demonstration looks like', () => {
  beforeEach(async () => {
    await seedOneShowcaseStore();
    await buildTrading(getDatabase());
  });

  it('never shows an order delivered before it could have arrived', async () => {
    // The assertion a careful visitor makes without being asked to. A random status pick produces
    // "ordered yesterday, delivered" on about a quarter of the rows, and that one row is enough to
    // tell somebody the data is fake.
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders
        WHERE shipping_status = 'delivered' AND created_at > now() - interval '4 days'`);
    expect(rows[0]!.n).toBe(0);
  });

  it('never leaves a three-month-old order still waiting to be picked', async () => {
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders
        WHERE shipping_status IN ('pending', 'processing') AND created_at < now() - interval '30 days'`);
    expect(rows[0]!.n).toBe(0);
  });

  it('dates no order to the last hour, so a rebuild is not mistaken for activity', async () => {
    // The reset job rebuilds this world hourly. An order written at NOW is genuinely minutes old,
    // and the admin bell — derived from these very rows — then toasts it at whoever opens the
    // dashboard next, about the demo rebuilding itself. Three hours is the floor.
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders WHERE created_at > now() - interval '2 hours'`);
    expect(rows[0]!.n).toBe(0);
  });

  it('writes a money-journal entry for every order, so the ledger and the orders agree', async () => {
    // `reconcile.ts` compares the journal against the order tables. An order with no entry behind
    // it surfaces in the admin's money log as a gap — a bug report about the demonstration.
    const { rows } = await query<{ orders: number; events: number }>(
      `SELECT (SELECT count(*)::int FROM orders) AS orders,
              (SELECT count(*)::int FROM money_events WHERE type = 'order_created') AS events`);
    expect(rows[0]!.events).toBe(rows[0]!.orders);
  });

  it('totals every order to its own lines plus its shipping', async () => {
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders o
        WHERE o.total_agorot <> o.shipping_agorot
              + (SELECT coalesce(sum(i.price_agorot * i.qty), 0) FROM order_items i WHERE i.order_id = o.id)`);
    expect(rows[0]!.n).toBe(0);
  });

  it('carries a failed charge among the paid ones', async () => {
    // Not decoration. `countsAsRevenue` excludes it, so it is the row that proves the reports are
    // filtering rather than summing everything they can see.
    const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE payment_status = 'failed'`);
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it('rates well but not uniformly, so the half star and the distribution bar both render', async () => {
    const { rows } = await query<{ distinct: number; avg: string }>(
      `SELECT count(DISTINCT rating)::int AS distinct, avg(rating)::text AS avg FROM product_reviews`);
    expect(rows[0]!.distinct).toBeGreaterThan(2);
    const avg = Number(rows[0]!.avg);
    expect(avg).toBeGreaterThan(3.5);
    expect(avg).toBeLessThan(5);
  });

  it('rebuilds the cached rating from the rows rather than counting while inserting', async () => {
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM store_products p
        WHERE p.review_count <> (SELECT count(*) FROM product_reviews r WHERE r.product_id = p.id AND NOT r.blocked)`);
    expect(rows[0]!.n).toBe(0);
  });

  it('hangs every review off an order that really happened, and was delivered', async () => {
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM product_reviews r
        WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = r.order_id AND o.shipping_status = 'delivered')`);
    expect(rows[0]!.n).toBe(0);
  });

  it('gives the traffic chart a weekly rhythm instead of noise', async () => {
    // Israeli retail is quiet Friday and Saturday. A flat line is what a generated chart looks like,
    // and the shape is the whole reason the analytics screen is worth showing at all.
    const { rows } = await query<{ weekend: string; midweek: string }>(
      `SELECT avg(total) FILTER (WHERE extract(dow from day) IN (5, 6))::text AS weekend,
              avg(total) FILTER (WHERE extract(dow from day) IN (0, 1, 2))::text AS midweek
         FROM store_page_views`);
    expect(Number(rows[0]!.weekend)).toBeLessThan(Number(rows[0]!.midweek) * 0.7);
  });

  it('leaves one campaign paused WITH a reason — the interesting half of that screen', async () => {
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ad_campaigns WHERE status = 'paused' AND paused_reason IS NOT NULL`);
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it('creates the buyer account the quick-login button signs into', async () => {
    const { rows } = await query<{ n: number }>('SELECT count(*)::int AS n FROM sellers WHERE email = $1', [DEMO_BUYER_EMAIL]);
    expect(rows[0]!.n).toBe(1);
  });

  it('is deterministic — an hourly reset must not move the numbers under a visitor', async () => {
    const first = await query<{ total: string }>('SELECT sum(total_agorot)::text AS total FROM orders');
    for (const t of ['product_reviews', 'money_events', 'order_items', 'order_stores', 'orders',
      'ad_campaigns', 'notifications', 'store_page_views', 'product_page_views']) {
      await query(`DELETE FROM ${t}`);
    }
    await buildTrading(getDatabase());
    const second = await query<{ total: string }>('SELECT sum(total_agorot)::text AS total FROM orders');
    expect(second.rows[0]!.total).toBe(first.rows[0]!.total);
  });
});

describe('the two inboxes', () => {
  beforeEach(async () => {
    await seedOneShowcaseStore();
    await buildTrading(getDatabase());
  });

  it('fills the shop inbox, and leaves one thread waiting', async () => {
    // An inbox where everything has been answered shows the seller nothing to do, which is the one
    // state that screen exists for. The owner noticed the empty version immediately.
    const { rows } = await query<{ total: number; unread: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE NOT read_by_seller AND reply_to_id IS NULL)::int AS unread
         FROM messages`);
    expect(rows[0]!.total).toBeGreaterThan(0);
    expect(rows[0]!.unread).toBeGreaterThan(0);
  });

  it('sends some threads from a signed-in buyer and some from a guest', async () => {
    // The two behave differently — `guest-sender.ts` decides whether a reply can become an in-app
    // notification or has to be a letter — so a demo carrying only one hides half the mechanism.
    const { rows } = await query<{ guests: number; accounts: number }>(
      `SELECT count(*) FILTER (WHERE from_user_id LIKE $1 || '%')::int AS guests,
              count(*) FILTER (WHERE from_user_id NOT LIKE $1 || '%')::int AS accounts
         FROM messages WHERE reply_to_id IS NULL`, [GUEST_SENDER_PREFIX]);
    expect(rows[0]!.guests).toBeGreaterThan(0);
    expect(rows[0]!.accounts).toBeGreaterThan(0);
  });

  it('writes a reply as a row in the thread, not as a field on the first message', async () => {
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages r
        WHERE r.reply_to_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM messages root WHERE root.id = r.reply_to_id)`);
    expect(rows[0]!.n, 'every reply points at a root that exists').toBe(0);
    const replies = await query<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE reply_to_id IS NOT NULL');
    expect(replies.rows[0]!.n).toBeGreaterThan(0);
  });

  it('fills the platform inbox with some unread, so the tab and the bell carry a number', async () => {
    const { rows } = await query<{ total: number; unread: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT read_by_admin)::int AS unread
         FROM admin_messages`);
    expect(rows[0]!.total).toBeGreaterThan(0);
    expect(rows[0]!.unread).toBeGreaterThan(0);
  });

  it('grows NO table it writes when the build runs again', async () => {
    /* The general form of the bug, and the reason this is not four separate assertions.
       The reset job re-runs this every hour on the live demo. Most of what it writes hangs off a
       store, and the stores are recreated, so it cascades away — but a table anchored to nothing
       survives, and the seeder then ADDS to it every hour for ever. The owner met exactly that:
       52 unread notifications, thirteen hours of four-per-run, and a toast for each new batch.

       Counting every table before and after a second build catches the NEXT table with that
       property, which is the one nobody will think of. */
    const TABLES = ['orders', 'order_items', 'order_stores', 'product_reviews', 'money_events',
      'store_page_views', 'product_page_views', 'ad_campaigns', 'notifications', 'messages',
      'admin_messages'] as const;
    const countAll = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const t of TABLES) {
        const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
        out[t] = rows[0]!.n;
      }
      return out;
    };

    // The REAL cycle, not two builds in a row: the reset job purges and reseeds, and almost
    // everything this function writes is anchored to a store and cascades away when the stores go.
    // Running `buildTrading` twice with no purge between would flag those too, which is not the bug
    // and would make the test noise. `purgeEverythingButShowcase` is the actual purge, called here
    // rather than imitated — an imitation would be a second definition of what gets deleted.
    const before = await countAll();
    // The real cycle in full. `purgeEverythingButShowcase` removes what visitors made; the
    // showcase stores themselves are then deleted and rewritten by `seed:showcase`, which is the
    // step that cascades away the orders, reviews, campaigns and threads hanging off them. Both are
    // the actual functions rather than an imitation — an imitation would be a second definition of
    // what gets deleted, which is the drift `seed-db.mjs` exists to prevent.
    await claim(getDatabase());
    await purgeEverythingButShowcase(getDatabase());
    await purgeOrdersOfStores(getDatabase(), 'showcase');
    await purge(getDatabase(), 'showcase', { includeSellers: false });
    await seedOneShowcaseStore();
    await buildTrading(getDatabase());
    const after = await countAll();

    const grew = TABLES.filter((t) => after[t]! > before[t]!)
      .map((t) => `${t}: ${before[t]} → ${after[t]}`);
    expect(grew, 'a table that survives the purge must be cleared by the seeder itself').toEqual([]);
  });

  it('does not multiply the platform inbox on a rebuild', async () => {
    // `messages` cascades away with its store; `admin_messages` hangs off a SELLER, and the
    // showcase owner is deliberately kept by the purge — so without an explicit clear the admin
    // inbox grew by four every hour the reset job ran.
    const before = await query<{ n: number }>('SELECT count(*)::int AS n FROM admin_messages');
    await buildTrading(getDatabase());
    const after = await query<{ n: number }>('SELECT count(*)::int AS n FROM admin_messages');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe('the bell a visitor first sees', () => {
  beforeEach(async () => {
    await seedOneShowcaseStore();
    await buildTrading(getDatabase());
  });

  it('carries a couple of notifications, not a wall of them', async () => {
    // The owner met 52 and then 4, and asked for 1-2. A bell exists to say something needs
    // attention; four identical lines say only that a seeder ran.
    const { rows } = await query<{ n: number }>('SELECT count(*)::int AS n FROM notifications');
    expect(rows[0]!.n).toBeGreaterThan(0);
    expect(rows[0]!.n).toBeLessThanOrEqual(2);
  });

  it('uses types the app can turn into a link', async () => {
    // The first draft wrote `order`, which `notification-link.ts` does not know — the row rendered
    // and the click went nowhere, which is worse than no notification at all. These are the real
    // seller-side types from that module.
    const { rows } = await query<{ type: string }>('SELECT DISTINCT type FROM notifications');
    const known = new Set(['new_order', 'order_update', 'new_message', 'admin_message',
      'return_update', 'payout_status', 'low_stock', 'out_of_stock', 'feed_status',
      'domain_status', 'store_live']);
    for (const { type } of rows) expect(known.has(type), `unknown notification type: ${type}`).toBe(true);
  });

  it('makes them different kinds, so the bell is not one line repeated', async () => {
    const { rows } = await query<{ n: number }>('SELECT count(DISTINCT type)::int AS n FROM notifications');
    expect(rows[0]!.n).toBeGreaterThan(1);
  });
});

describe('the clearing account behind the Payments tab', () => {
  it('back-dates the merchant so a shop trading for a quarter is not stuck in review', async () => {
    await seedOneShowcaseStore();
    await seedClearing(getDatabase());
    const { rows } = await query<{ approved: boolean; age_days: number }>(
      `SELECT approved, extract(day from now() - created_at)::int AS age_days
         FROM seller_merchant_accounts WHERE seller_id = $1`, [SELLER]);
    expect(rows[0]!.approved).toBe(true);
    // `payme-demo.ts` reads THIS row's created_at to decide approval. A merchant created a moment
    // ago would spend the visitor's first twenty seconds in review.
    expect(rows[0]!.age_days).toBeGreaterThan(1);
    const sub = await query<{ status: number }>('SELECT status FROM seller_subscriptions WHERE seller_id = $1', [SELLER]);
    expect(sub.rows[0]!.status).toBe(2);   // PAYME_SUB_STATUS.active
  });
});

describe('the visitor-built stores the reset job has to remove', () => {
  it('removes a shop a visitor registered, and keeps the showcase', async () => {
    await seedOneShowcaseStore();
    // Claimed BEFORE the visitor's shop exists — which is the real sequence: a database is declared
    // the demonstration while it holds only seeded data, and visitors arrive afterwards. Claiming
    // after would be refused, and the previous version of this test proved it.
    await claim(getDatabase());
    const visitor = '88888888-8888-4888-8888-000000000009';
    await query('INSERT INTO sellers (id, name, email) VALUES ($1, $2, $3)', [visitor, 'Visitor', 'someone@example.com']);
    await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, 'a-visitors-shop', 'חנות של מבקר')`,
      ['88888888-8888-4888-8888-00000000000a', visitor]);

    await purgeEverythingButShowcase(getDatabase());

    const { rows } = await query<{ slug: string }>('SELECT slug FROM stores WHERE deleted_at IS NULL ORDER BY slug');
    expect(rows.map((r) => r.slug)).toEqual(['showcase-test']);
    // The account goes too — an abandoned login left behind by every visitor is how a demonstration
    // slowly fills with accounts nobody can use.
    const left = await query<{ n: number }>('SELECT count(*)::int AS n FROM sellers WHERE email = $1', ['someone@example.com']);
    expect(left.rows[0]!.n).toBe(0);
  });
});

describe('the identities that live in two files', () => {
  it('still agree, so a quick-login button cannot land on a login form', () => {
    // `scripts/` is run by plain Node and cannot import a `.ts` module, so the emails are spelled
    // twice. This is the guard that comment promises.
    const seeder = readFileSync(new URL('../scripts/seed-portfolio.mjs', import.meta.url), 'utf8');
    expect(seeder).toContain(`'${DEMO_BUYER_EMAIL}'`);
    const seedDb = readFileSync(new URL('../scripts/lib/seed-db.mjs', import.meta.url), 'utf8');
    expect(seedDb).toContain(`'${DEMO_SELLER_EMAIL}'`);
    // The guest-sender prefix is the third of these, and the one with teeth: it decides whether a
    // reply becomes an in-app notification or a letter, and `tests/guest-sender.test.ts` scans
    // `src/` only — so the seeder's copy is outside that net and needs this.
    expect(seeder).toContain(`const GUEST_PREFIX = '${GUEST_SENDER_PREFIX}'`);
  });
});
