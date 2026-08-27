#!/usr/bin/env node
/**
 * The portfolio demonstration's whole world, in one command.
 *
 *   npm run demo:claim        # ONCE, against the demo database — see THE GUARD below
 *   npm run seed:portfolio    # build it, or rebuild it from scratch
 *
 * `seed:showcase` writes four beautiful, empty shops. This writes the months of trading behind
 * them: orders across every status spread over a quarter, reviews hanging off orders that really
 * happened, page views with a curve rather than a flat line, campaigns with budget and spend,
 * notifications, an approved clearing account and a paying subscription. A demonstration whose
 * dashboards are all zeroes demonstrates nothing — every screen worth showing is a screen that
 * needs data behind it, and reaching even one of these states by hand takes a seller session, a
 * buyer session and a clock that has already run out.
 *
 * ── THE GUARD, and why it is a row in the database rather than a flag ────────
 *
 * This script DELETES EVERY STORE THAT IS NOT A SHOWCASE STORE (owner, 2026-08-26). Pointed at the
 * development database by a stale `DATABASE_URL` — one export in a shell, one copied `.env` — that
 * is somebody's work gone.
 *
 * `DEMO_MODE=1` is not enough of a guard, because the variable travels with the environment and the
 * database does not. So the demo database must SAY it is the demo database: `npm run demo:claim`
 * writes one row into `app_settings`, and every destructive path here refuses without it. A
 * development database has never been claimed and never will be, so the accident cannot happen —
 * and claiming is itself refused if the database holds anything that is not seeded data, which is
 * what stops the claim being made by mistake on the very database it protects.
 *
 * Same shape as `seed-db.mjs`'s purge gate: the safety comes from a property of the DATA, not from
 * remembering to type the right thing.
 *
 * ── What it does NOT invent ─────────────────────────────────────────────────
 *
 * Nothing here writes a number a screen would contradict. Ratings are recomputed from the review
 * rows rather than counted while inserting; a store's revenue is whatever its orders add up to;
 * money-journal entries are written for the orders that exist and nothing else. The one figure a
 * demonstration cannot have is PayMe's own ledger — what a charge really cost and what really
 * reached a bank — and `payme-demo.ts` answers that empty rather than fabricate it.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  SHOWCASE_OWNER_EMAIL, SEED_SCOPES, DEMO_CLAIM_KEY, isDemoDatabase,
  openSeedClient, purge, purgeOrdersOfStores, purgeOrphanJournalRows,
} from './lib/seed-db.mjs';

/** Kept in step with `src/lib/demo-mode.ts` by `tests/seed-portfolio.test.ts` — this file is run
 *  by plain Node and cannot import a `.ts` module. */
const DEMO_BUYER_EMAIL = 'buyer@demo.local';

/**
 * `lib/guest-sender.ts#GUEST_SENDER_PREFIX`, spelled again for the same reason as the address
 * above: plain Node, no TypeScript import.
 *
 * It marks a message sender who has NO account, and what turns on it is whether a reply becomes an
 * in-app notification or a letter — so a demo that seeded only signed-in senders would leave half
 * that mechanism invisible. `tests/seed-portfolio.test.ts` asserts this equals the exported
 * constant; the tree-wide guard in `tests/guest-sender.test.ts` scans `src/` only, so this copy is
 * outside its reach and needs its own.
 */
const GUEST_PREFIX = 'order:';

const uuid = () => crypto.randomUUID();
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const day = (ms) => iso(ms).slice(0, 10);

/**
 * Deterministic randomness, seeded from a constant.
 *
 * A re-seed produces the SAME demonstration — the same orders on the same days, the same ratings,
 * the same curve on the analytics chart. That matters more here than variety: the hourly reset job
 * rebuilds this, and a visitor who reloads a dashboard should not watch its numbers change under
 * them for no reason a person could explain.
 */
const SEED = 20260826;
let seed = SEED;
/** Back to the start of the sequence. Called at the top of `buildTrading`, because the generator is
 *  module state and a SECOND build in the same process would otherwise carry on from wherever the
 *  first one stopped — which is not determinism, it is determinism-per-process, and the reset job
 *  rebuilds inside a long-lived server. Found by the test, not by reasoning. */
const reseed = () => { seed = SEED; };
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const shuffle = (arr) => arr.map((v) => [rnd(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

const FIRST = ['נועה', 'איתי', 'שירה', 'יונתן', 'מיכל', 'דניאל', 'תמר', 'עומר', 'ליאור', 'רוני', 'אורי', 'הדס', 'יעל', 'אלון', 'מאיה', 'גיא'];
const LAST = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אברהם', 'פרידמן', 'שפירא', 'אזולאי', 'דהן', 'גבאי', 'סגל'];
const CITIES = ['תל אביב-יפו', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה', 'באר שבע', 'נתניה', 'רמת גן', 'מודיעין', 'כפר סבא'];
const STREETS = ['הרצל', 'ביאליק', 'ז׳בוטינסקי', 'רוטשילד', 'ויצמן', 'בן גוריון', 'הנביאים', 'אבן גבירול'];
/**
 * What a shopper actually writes to a shop, and what a seller writes to the platform.
 *
 * Both inboxes were empty in the first version and the owner noticed immediately — a dashboard
 * whose messages tab says "nothing here" is a dashboard with a feature nobody can see. They are
 * ordinary, slightly dull sentences on purpose: an inbox where every enquiry is a crisis reads as
 * theatre, and the states worth showing are a thread waiting for an answer, a thread already
 * answered, and one that is merely a question.
 */
const BUYER_TO_SELLER = [
  ['שאלה על מידה', 'היי, אני מתלבטת בין S ל-M. יש טבלת מידות מפורטת יותר?'],
  ['מתי יישלח?', 'הזמנתי אתמול ורציתי לדעת מתי זה יוצא למשלוח.'],
  ['אפשר לאסוף?', 'אני גר קרוב, יש אפשרות לאסוף במקום במקום משלוח?'],
  ['הפריט חזר למלאי?', 'ראיתי שהפריט אזל. יש הערכה מתי הוא חוזר?'],
  ['החלפת צבע', 'אפשר להחליף את הצבע שהזמנתי לפני שזה נשלח?'],
  ['חשבונית', 'אפשר לקבל חשבונית על ההזמנה?'],
];
const SELLER_REPLIES = [
  'היי, בהחלט. הוספתי טבלת מידות לעמוד המוצר, תעיפי מבט ותגידי לי אם עוד משהו לא ברור.',
  'יוצא היום אחר הצהריים, תקבל מספר מעקב במייל.',
  'כן, אפשר בהחלט. תכתוב לי מתי נוח לך ואשאיר בצד.',
  'אמור לחזור בשבוע הבא, אעדכן אותך ברגע שזה נכנס.',
];
const SELLER_TO_ADMIN = [
  ['שאלה על העמלה', 'רציתי להבין איך מחושבת העמלה על מכירה עם משלוח.'],
  ['תקלה בהעלאת תמונות', 'ניסיתי להעלות גלריה של 12 תמונות ואחת מהן נתקעה.'],
  ['שינוי מסלול', 'אני שוקל לעבור למסלול גבוה יותר, מתי השינוי נכנס לתוקף?'],
  ['פיד מלאי', 'הפיד שלי מתעדכן פעם ביום, אפשר לקצר את זה?'],
];

const REVIEWS = [
  'הגיע מהר ובאריזה טובה. בדיוק כמו בתמונות.',
  'איכות מצוינת ביחס למחיר. אקנה שוב.',
  'יפה מאוד, אבל קצת יותר קטן ממה שציפיתי.',
  'שירות אדיב והמוצר תקין. ממליץ.',
  'סביר. לא רע, לא מדהים.',
  'הגיע יומיים אחרי ההזמנה, ארוז יפה.',
  'המידה קצת גדולה, שווה לבדוק לפני שמזמינים.',
  'בדיוק מה שחיפשתי לבית.',
];
const name = () => `${pick(FIRST)} ${pick(LAST)}`;

// ─────────────────────────────────────────────────────────────────────────────
// The guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refuse to claim a database that holds anything a seeder did not make.
 *
 * This is the half that makes the claim safe to run at all. Without it, `demo:claim` typed against
 * the wrong connection would mark the development database as disposable — and every later run of
 * this script would then cheerfully empty it.
 */
export async function claim(db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM stores
      WHERE deleted_at IS NULL AND NOT (${SEED_SCOPES.showcase.stores}) AND NOT (${SEED_SCOPES.demo.stores})`,
  );
  const real = Number(rows[0]?.n ?? 0);
  if (real > 0) {
    console.error(
      `\n❌ Refusing to claim: this database holds ${real} store(s) that no seeder made.\n` +
      '   `seed:portfolio` deletes every store that is not a showcase store, so it may only ever\n' +
      '   run against a database created FOR the demonstration. Check DATABASE_URL — this looks\n' +
      '   like the development one.\n',
    );
    process.exit(1);
  }
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [DEMO_CLAIM_KEY, JSON.stringify({ claimedAt: iso(NOW) })],
  );
  console.log('\n✅ Claimed. `npm run seed:portfolio` may now rebuild this database from scratch.\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The build
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} [onConflict] e.g. `ON CONFLICT DO NOTHING`, for a table whose natural key means a
 *   second build would collide rather than duplicate. Two of them have one — the page-view tables
 *   are keyed on (row, day) — and without this `buildTrading` could only ever run against a
 *   database the purge had just emptied. Making it re-runnable on its own is worth the parameter:
 *   the reset job's safety then rests on the statement rather than on the order of two functions.
 */
async function insertMany(db, table, columns, rows, onConflict = '') {
  if (!rows.length) return;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = slice.map((row, r) =>
      `(${row.map((_, c) => `$${r * columns.length + c + 1}`).join(',')})`).join(',');
    await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values} ${onConflict}`, slice.flat());
  }
}

/**
 * Everything that is not a showcase store, gone — the owner's instruction, and the whole reason
 * this file needs a guard above it.
 *
 * Orders first: `purge` deletes the stores, and once a store's row is gone there is no slug left to
 * recognise its orders by. `includeSellers` on the demo scope, because a visitor who registered
 * during the demonstration leaves an account behind as well as a shop.
 */
export async function purgeEverythingButShowcase(db) {
  /* Through the `portfolio` scope, and not one `DELETE` written here.
     `tests/seed-purge-gate.test.ts` greps `scripts/` for exactly that and it caught this
     function's first draft: a seeder NAMES what it disposes of and never composes its own
     `WHERE`. The scope, its claim gate and the multi-store keeper rule all live in
     `seed-db.mjs`, which is the file that owns deletion.

     Orders first — `purge` removes the stores, and once a store's row is gone there is no slug
     left to recognise its orders by. */
  const orders = await purgeOrdersOfStores(db, 'portfolio');
  const removed = await purge(db, 'portfolio');
  console.log(`   removed ${removed.stores} store(s), ${removed.sellers} account(s), ${orders.deleted} order(s)`);
}

async function seedShowcase() {
  // A child process rather than an import: `seed-showcase-stores.mjs` owns the stores, the images
  // and the purge that goes with them, and its `seed()` is not exported precisely so that nothing
  // half-uses it. `--live` drops the `demo` flag, which is what lets a visitor buy from them.
  execFileSync(process.execPath, ['--env-file-if-exists=.env', 'scripts/seed-showcase-stores.mjs', '--live'], { stdio: 'inherit' });
}

export async function buildTrading(db) {
  reseed();
  const { rows: stores } = await db.query(
    `SELECT s.id, s.slug, s.name, s.seller_id FROM stores s
       JOIN sellers sel ON sel.id = s.seller_id
      WHERE sel.email = $1 AND s.deleted_at IS NULL ORDER BY s.slug`, [SHOWCASE_OWNER_EMAIL]);
  if (!stores.length) {
    console.error('\n❌ No showcase stores found after seeding them. Nothing else written.\n');
    process.exit(1);
  }

  const buyerId = uuid();
  await db.query(
    `INSERT INTO sellers (id, name, email, password_hash, created_at)
          VALUES ($1, $2, $3, '', $4)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [buyerId, 'נועה כהן', DEMO_BUYER_EMAIL, iso(NOW - 200 * DAY)]);
  const { rows: buyerRow } = await db.query('SELECT id FROM sellers WHERE email = $1', [DEMO_BUYER_EMAIL]);
  const demoBuyerId = buyerRow[0].id;

  const orders = [];
  const items = [];
  const orderStores = [];
  const reviews = [];
  const events = [];
  const storeViews = [];
  const productViews = [];
  const campaigns = [];
  const notifications = [];
  const messages = [];
  const adminMessages = [];

  for (const store of stores) {
    const { rows: products } = await db.query(
      `SELECT p.id, p.slug, p.name, p.price_agorot,
              (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY position LIMIT 1) AS image
         FROM store_products p WHERE p.store_id = $1 AND NOT p.hidden ORDER BY p.slug`, [store.id]);
    if (!products.length) continue;

    /* ── Orders ──────────────────────────────────────────────────────────────
       Weighted towards recent days, because a real shop's order list is: a flat spread across a
       quarter makes every "last 30 days" figure on the dashboard equal to every other, and the
       charts come out as straight lines. `daysAgo` squared does the tilt in one expression. */
    for (let o = 0; o < 28; o++) {
      const daysAgo = Math.round(110 * rnd() * rnd());
      const created = NOW - daysAgo * DAY;
      const lines = shuffle(products).slice(0, int(1, 3));
      const orderId = uuid();
      let subtotal = 0;
      lines.forEach((p, position) => {
        const qty = int(1, 2);
        subtotal += Number(p.price_agorot) * qty;
        items.push([uuid(), orderId, p.id, p.name, p.slug, store.slug, store.name,
          Number(p.price_agorot), qty, p.image, null, position]);
      });
      const shipping = subtotal >= 24_900 ? 0 : pick([2000, 2500, 3000]);
      /* The status follows the CLOCK, which is the part a random pick gets wrong: an order placed
         two days ago cannot be delivered, and one from three months ago cannot still be pending.
         A demonstration whose order list contradicts its own dates is the first thing a careful
         person notices. */
      const status = daysAgo > 21 ? 'delivered'
        : daysAgo > 8 ? pick(['delivered', 'delivered', 'shipped'])
        : daysAgo > 3 ? pick(['shipped', 'processing'])
        : pick(['processing', 'pending']);
      const shipped = status === 'shipped' || status === 'delivered';
      // Every twentieth order is a failed charge that never became a sale. `countsAsRevenue`
      // excludes it, so it is also the row that proves the reports are filtering rather than
      // summing everything they can see.
      const paid = rnd() > 0.05;
      orders.push([
        orderId, `CHK-${orderId.slice(0, 8)}`, rnd() < 0.35 ? demoBuyerId : null,
        name(), `${pick(['noa', 'itai', 'shira', 'yonatan', 'michal'])}${int(10, 99)}@example.com`,
        `05${int(0, 9)}-${int(1000000, 9999999)}`,
        pick(CITIES), `${pick(STREETS)} ${int(1, 90)}`, `${int(1000000, 9999999)}`,
        shipping, subtotal + shipping,
        paid ? `demo-sale-${orderId.slice(0, 12)}` : null,
        paid ? 'paid' : 'failed', paid ? status : 'cancelled',
        shipped && paid ? `IL${int(100000000, 999999999)}` : null,
        iso(created), iso(created + int(0, 4) * DAY),
      ]);
      orderStores.push([orderId, store.slug, store.name, subtotal, shipping, 'delivery']);

      /* The money journal — the independent record `reconcile.ts` compares against the order
         tables. Seeded orders with no journal behind them would show up in the admin's money log
         as a gap, which is a bug report about the demonstration rather than a demonstration. */
      events.push([uuid(), iso(created), 'order_created', orderId, `CHK-${orderId.slice(0, 8)}`,
        store.slug, subtotal + shipping, null, paid ? 'paid' : 'failed', 'buyer', `${lines.length} item(s)`]);

      if (paid && status === 'delivered') {
        for (const p of lines) {
          if (rnd() >= 0.4) continue;
          reviews.push([uuid(), p.id, store.slug, orderId, null,
            `${pick(FIRST)} ${pick(['א׳', 'ב׳', 'כ׳', 'ל׳', 'מ׳', 'ש׳'])}`,
            // Skewed high, but not uniformly five: a demonstration that averages 3.0 looks like a
            // failing shop, and one that is all fives never renders the half star or the
            // distribution bar — which are exactly the parts worth looking at.
            pick([5, 5, 5, 4, 4, 4, 3, 2]),
            rnd() < 0.75 ? pick(REVIEWS) : '', iso(created + int(3, 20) * DAY)]);
        }
      }
    }

    /* ── Traffic ─────────────────────────────────────────────────────────────
       A weekly rhythm rather than noise: Israeli retail is quiet on Friday and Saturday and busiest
       Sunday to Tuesday, and a chart without that shape reads as generated. */
    for (let d = 0; d < 120; d++) {
      const at = NOW - d * DAY;
      const weekday = new Date(at).getDay();          // 0 = Sunday, 5 = Friday, 6 = Saturday
      const rhythm = weekday === 5 ? 0.35 : weekday === 6 ? 0.5 : weekday <= 2 ? 1.15 : 0.9;
      // A gentle upward trend towards today, so "growth" is visible without being a hockey stick.
      const trend = 1 + (120 - d) / 400;
      storeViews.push([store.id, day(at), Math.max(1, Math.round(int(40, 130) * rhythm * trend))]);
    }
    for (const p of shuffle(products).slice(0, 30)) {
      for (let d = 0; d < 60; d += int(1, 2)) {
        productViews.push([p.id, day(NOW - d * DAY), int(2, 40)]);
      }
    }

    /* ── One live campaign per shop, one paused ──────────────────────────────
       The paused one carries a reason, because the pause REASONS are the interesting half of that
       screen and an all-green advertising tab shows none of them. */
    campaigns.push([uuid(), store.id, store.slug, 'store', null, null, [], [], [], [],
      pick(['google', 'meta', 'both']), pick([30_000, 50_000, 80_000]), 30, null, null,
      'active', null, null, null, iso(NOW - int(20, 80) * DAY), iso(NOW - int(1, 10) * DAY)]);
    campaigns.push([uuid(), store.id, store.slug, 'store', null, null, [], [], [], [],
      'google', 25_000, 14, null, null,
      'paused', iso(NOW - int(2, 15) * DAY), 'out-of-stock', null,
      iso(NOW - int(30, 90) * DAY), iso(NOW - int(2, 15) * DAY)]);


    /* ── The shop's own inbox ──────────────────────────────────────────────
       Three threads a shop, and the third is deliberately left UNANSWERED and unread: an inbox
       where everything has been dealt with shows the seller nothing to do, which is the one state
       that screen exists for. The sender is a signed-in buyer on some and a guest on others —
       `guest-sender.ts` makes those two behave differently (a guest cannot receive an in-app
       notification, only a letter), so a demo carrying only one of them hides half the mechanism. */
    for (let m = 0; m < 3; m++) {
      const [subject, body] = pick(BUYER_TO_SELLER);
      const asGuest = m === 1;
      const rootId = uuid();
      const askedAt = NOW - int(2, 40) * DAY;
      const answered = m < 2;
      messages.push([rootId, asGuest ? `${GUEST_PREFIX}${uuid().slice(0, 8)}` : demoBuyerId,
        name(), asGuest ? 'guest@example.com' : DEMO_BUYER_EMAIL,
        store.id, store.seller_id, store.name, subject, body, null, null,
        answered, true, iso(askedAt)]);
      if (answered) {
        // A reply is a row in the same thread pointing at the root, exactly as the dashboard writes
        // one — not a second field on the first message.
        messages.push([uuid(), store.seller_id, store.name, '', store.id, store.seller_id,
          store.name, subject, pick(SELLER_REPLIES), null, rootId, true, false,
          iso(askedAt + int(2, 20) * 3600_000)]);
      }
    }
  }

  /* ── The bell: TWO notifications, and the number is the point ─────────────
     The first version wrote one per shop, and the reset job could not clear them — the owner met a
     bell with 52 unread and a toast for every batch. Even once that was fixed, four was too many:
     a bell exists to say something needs attention, and four identical "new order" lines say only
     that a seeder ran (owner: *"ולא 8 התראות, מספיק 1-2"*).

     The types are the application's real ones, from `notification-link.ts`, not descriptive
     strings. The first draft used `order`, which that module does not know — so the row rendered
     and the click went nowhere, which is worse than having no notification at all. */
  if (stores.length) {
    const shop = stores[0];
    notifications.push([uuid(), shop.seller_id, 'seller', 'new_order',
      'הזמנה חדשה', `התקבלה הזמנה חדשה בחנות ${shop.name}.`, false, null,
      shop.slug, shop.name, iso(NOW - int(1, 6) * 3600_000)]);
    notifications.push([uuid(), shop.seller_id, 'seller', 'new_message',
      'פנייה חדשה מקונה', 'נשאלה שאלה על אחד המוצרים.', false, null,
      shop.slug, shop.name, iso(NOW - int(7, 30) * 3600_000)]);
  }

  /* ── The PLATFORM's inbox ────────────────────────────────────────────────
     Sellers writing to us, which is a different table and a different screen (`admin_messages`,
     the admin's הודעות tab). Two of the four are unread, so the tab carries a number and the new
     bell has something in it — an admin dashboard whose every signal is at zero demonstrates the
     signals, not the work. */
  for (let i = 0; i < SELLER_TO_ADMIN.length; i++) {
    const [subject, body] = SELLER_TO_ADMIN[i];
    adminMessages.push([uuid(), stores[i % stores.length].seller_id, 'seller', subject, body,
      null, i >= 2, iso(NOW - int(1, 30) * DAY)]);
  }

  await db.query('BEGIN');
  try {
    /* ── What the purge does NOT reach, cleared by hand ──────────────────────
       Most of what this function writes is anchored to a store or a product, and the stores are
       deleted and recreated on every run — so orders, reviews, page views, campaigns and the shops'
       own message threads all cascade away by themselves. Two tables do not, and BOTH of them grew
       by a fixed amount every hour the reset job ran until this was written:

         `admin_messages` hangs off a SELLER, and the showcase owner is deliberately kept.
         `notifications`  hangs off NOTHING — `user_id` is a plain text column with no foreign key,
                          because a notification can belong to a guest. So nothing cascades it, and
                          the owner met the result on the live demo: 52 unread, thirteen hours of
                          four-per-run, and a toast for each new batch. The poller was right; the
                          seeder was wrong.

       `tests/seed-portfolio.test.ts` runs the build twice and asserts that no table it writes grows,
       which is the check that catches the NEXT table with this property rather than this one. */
    await db.query(
      `DELETE FROM admin_messages WHERE seller_id IN (SELECT id FROM sellers WHERE email = $1)`,
      [SHOWCASE_OWNER_EMAIL]);
    await db.query(
      `DELETE FROM notifications WHERE user_id IN (SELECT id::text FROM sellers WHERE email = $1)`,
      [SHOWCASE_OWNER_EMAIL]);
    await insertMany(db, 'orders', ['id', 'checkout_ref', 'buyer_id', 'buyer_name', 'buyer_email',
      'buyer_phone', 'buyer_city', 'buyer_street', 'buyer_zip', 'shipping_agorot', 'total_agorot',
      'payment_ref', 'payment_status', 'shipping_status', 'tracking_number', 'created_at', 'updated_at'], orders);
    await insertMany(db, 'order_items', ['id', 'order_id', 'product_id', 'product_name', 'product_slug',
      'store_slug', 'store_name', 'price_agorot', 'qty', 'image', 'selected_variants', 'position'], items);
    await insertMany(db, 'order_stores', ['order_id', 'store_slug', 'store_name', 'subtotal_agorot',
      'shipping_agorot', 'delivery_method'], orderStores, 'ON CONFLICT DO NOTHING');
    await insertMany(db, 'product_reviews', ['id', 'product_id', 'store_slug', 'order_id', 'buyer_id',
      'reviewer_name', 'rating', 'body', 'created_at'], reviews);
    await insertMany(db, 'money_events', ['id', 'at', 'type', 'order_id', 'checkout_ref', 'store_slug',
      'amount_agorot', 'from_value', 'to_value', 'actor', 'detail'], events);
    await insertMany(db, 'store_page_views', ['store_id', 'day', 'total'], storeViews, 'ON CONFLICT DO NOTHING');
    await insertMany(db, 'product_page_views', ['product_id', 'day', 'total'], productViews, 'ON CONFLICT DO NOTHING');
    await insertMany(db, 'ad_campaigns', ['id', 'store_id', 'store_slug', 'scope', 'product_id',
      'product_name', 'product_ids', 'product_names', 'category_ids', 'category_names', 'platform',
      'monthly_budget_agorot', 'duration_days', 'audience_gender', 'audience_age', 'status',
      'paused_at', 'paused_reason', 'archived_at', 'created_at', 'updated_at'], campaigns);
    await insertMany(db, 'notifications', ['id', 'user_id', 'role', 'type', 'title', 'body', 'read',
      'related_id', 'store_slug', 'store_name', 'created_at'], notifications);
    await insertMany(db, 'messages', ['id', 'from_user_id', 'from_name', 'from_email', 'to_store_id',
      'to_seller_id', 'to_store_name', 'subject', 'content', 'product_ref', 'reply_to_id',
      'read_by_seller', 'read_by_buyer', 'created_at'], messages);
    await insertMany(db, 'admin_messages', ['id', 'seller_id', 'from_role', 'subject', 'content',
      'reply_to_id', 'read_by_admin', 'created_at'], adminMessages);

    // The cached rating is a CACHE, rebuilt from the rows exactly as `recomputeProductRating` does
    // it — never counted up while inserting. A seeder that maintained the aggregate itself would be
    // its second definition, and the one that gets it wrong the day the rule changes.
    await db.query(`UPDATE store_products p
                       SET review_count = agg.n, review_rating_sum = agg.total
                      FROM (SELECT product_id, count(*)::int AS n, sum(rating)::int AS total
                              FROM product_reviews WHERE NOT blocked GROUP BY product_id) agg
                     WHERE agg.product_id = p.id`);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }

  return { stores: stores.length, orders: orders.length, reviews: reviews.length,
           campaigns: campaigns.length, messages: messages.length + adminMessages.length };
}

/**
 * The clearing account and the subscription, so the Payments tab is a working screen.
 *
 * Back-dated: `payme-demo.ts` approves a business once `DEMO_APPROVAL_SECONDS` have passed since
 * its account was opened, and it reads that from THIS row. A showcase seller created a moment ago
 * would otherwise spend his first twenty seconds in review, on a shop that has supposedly been
 * trading for a quarter.
 */
export async function seedClearing(db) {
  const { rows } = await db.query('SELECT id FROM sellers WHERE email = $1', [SHOWCASE_OWNER_EMAIL]);
  const sellerId = rows[0]?.id;
  if (!sellerId) return;
  const ref = `demo-mrc-${(NOW - 200 * DAY).toString(36)}-show`;
  await db.query(
    `INSERT INTO seller_merchant_accounts (seller_id, provider_ref, callback_secret, public_key, signup_link, approved, created_at)
          VALUES ($1, $2, $3, $4, '', true, $5)
       ON CONFLICT (seller_id) DO UPDATE
          SET provider_ref = EXCLUDED.provider_ref, approved = true, created_at = EXCLUDED.created_at`,
    [sellerId, ref, crypto.randomBytes(16).toString('hex'), `demo-pk-${crypto.randomBytes(6).toString('hex')}`, iso(NOW - 200 * DAY)]);

  const next = new Date(NOW + 20 * DAY);
  await db.query(
    `INSERT INTO seller_subscriptions (seller_id, provider_ref, tier, price_agorot, status, started_at, next_charge, created_at)
          VALUES ($1, $2, 'growth', 12500, 2, $3, $4, $3)
       ON CONFLICT (seller_id) DO UPDATE
          SET status = 2, canceled_at = NULL, next_charge = EXCLUDED.next_charge`,
    [sellerId, `demo-sub-${(NOW - 200 * DAY).toString(36)}`, iso(NOW - 200 * DAY),
     next.toISOString().slice(0, 19).replace('T', ' ')]);
}

async function main() {
  const db = await openSeedClient();
  try {
    if (process.argv.includes('--claim')) { await claim(db); return; }

    if (!(await isDemoDatabase(db))) {
      console.error(
        '\n❌ This database has not been claimed as the demonstration database.\n' +
        '   `seed:portfolio` deletes every store that is not a showcase store, so it refuses to\n' +
        '   run until the database itself says it is disposable:\n\n' +
        '       npm run demo:claim\n\n' +
        '   Run that against the DEMO connection only. It refuses on a database holding anything\n' +
        '   a seeder did not make, which is what stops it being typed against the wrong one.\n',
      );
      process.exit(1);
    }

    console.log('\n🧹 Removing every store that is not a showcase store…');
    await purgeEverythingButShowcase(db);
  } finally {
    await db.end();
  }

  seedShowcase();

  const db2 = await openSeedClient();
  try {
    console.log('\n📦 Building the trading history…');
    const built = await buildTrading(db2);
    await seedClearing(db2);
    await purgeOrphanJournalRows(db2);
    console.log(
      `\n✅ Portfolio demo ready.\n` +
      `   stores: ${built.stores}   orders: ${built.orders}   reviews: ${built.reviews}   campaigns: ${built.campaigns}   messages: ${built.messages}\n` +
      `   Sign in at /demo — no credentials.\n`,
    );
  } finally {
    await db2.end();
  }
}

/**
 * Only when RUN, never when imported.
 *
 * `tests/seed-portfolio.test.ts` imports the functions above to drive them against the real schema,
 * and without this line that import ran the whole script — including its `process.exit(1)` when the
 * test database is, correctly, unclaimed. A module whose side effect is "empty a database" must not
 * have that side effect on `import`.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
