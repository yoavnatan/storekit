#!/usr/bin/env node
/**
 * Every return/cancellation scenario, on screen, at once — so the mechanism can be LOOKED at.
 *
 *   npm run seed:returns             # write one case in every state
 *   npm run seed:returns -- --clean  # remove them (and the orders they hang from)
 *
 * ── Why this exists (owner, 2026-08-20) ──
 * *"אני חייב לראות בעיניים שלי דוגמאות לאיך זה נראה. ממש איך כל תרחיש סביר נראה במערכת... זה מרגיש
 * לי באוויר."* The returns mechanism is nine states, three screens and half a dozen clocks, and all
 * of it was verified by tests — which prove behaviour and show nothing. Reaching even one of these
 * states by hand takes a delivered order, a buyer session, a seller session and, for four of them, a
 * clock that has already run out. That is why it felt like nothing: there was no way to look.
 *
 * So this puts one case of each on the platform, with its clocks already where they need to be, and
 * prints where each one is visible. He logs in and presses the real buttons on real rows — every
 * screen below is the production screen, not a preview of one.
 *
 * ── What it writes, and why that is safe ──
 * DEMO STORES ONLY (`@demo.local` sellers, `seed-db.mjs`'s `demo` scope) — never a real seller's
 * shop. That is the same rule `seed-reviews.mjs` had to learn the hard way: a demo case hanging off
 * a real order would put invented revenue into the accountant's report and invented debts onto the
 * reconciliation card. A return needs a DELIVERED order to exist at all, so this creates its own —
 * and marks each one with a `payment_ref` prefix nothing else on the platform writes, which is the
 * whole of the purge below.
 *
 * It writes the rows DIRECTLY rather than through `openReturnRequest`/`moveReturnRequest`, and that
 * is deliberate: those are the functions being demonstrated, and driving them would move real money
 * (`settleStatusChange` writes journal rows, refund obligations and seller clawbacks for a case that
 * never happened). A seeded case is a POSE — the screens read it exactly as they read a live one,
 * and pressing a button on it runs the real code from there.
 *
 * ── The buyer's side ──
 * Demo orders are guest checkouts, so nothing of theirs appears in `/buyer/dashboard`. Three of the
 * nine states are answered by the BUYER and nowhere else — accepting an offer, declaring the parcel
 * sent, appealing a refusal — so these orders carry a real buyer account and he can sign into it.
 */
import crypto from 'node:crypto';
import { openSeedClient, DEMO_EMAIL_SUFFIX, RETURN_DEMO_PAYMENT_REF, purgeReturnDemo } from './lib/seed-db.mjs';

const CLEAN = process.argv.includes('--clean');

/**
 * `--store <slug>` — stage the scenarios in ONE named shop instead of across the demo ones.
 *
 * It exists because the demo stores are not where the owner already is. He looks at these screens
 * signed into his own dashboard, and "log out, log in as seller3@demo.local, look, log back" is the
 * friction that made the mechanism feel unexamined in the first place. Naming a shop is him choosing
 * to put staged orders in it, which is a different act from a seeder deciding to on its own — the
 * default stays demo-only.
 *
 * Reversible either way, and exactly: every order written here carries `RETURN_DEMO_PAYMENT_REF`,
 * and `--clean` deletes by that and by nothing else.
 */
const STORE_FLAG = (() => {
  const i = process.argv.findIndex((a) => a === '--store' || a.startsWith('--store='));
  if (i === -1) return null;
  const arg = process.argv[i];
  return (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : process.argv[i + 1]) || null;
})();

/** The two accounts this demo is driven from. Both inside the `@demo.local` scope, so
 *  `npm run seed:demo -- --clean` disposes of them like everything else. */
const BUYER_EMAIL = `buyer${DEMO_EMAIL_SUFFIX}`;
const PASSWORD = 'demo1234';

const DAY = 86_400_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

/** `scrypt:<salt>:<hash>` — the format `seller-auth.ts#verifyPassword` reads. Written here rather
 *  than imported because that module deliberately exports neither half of it. */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

/**
 * The scenarios, in the order a case actually travels — which is also the order they read in.
 *
 * `deliveredDaysAgo` is load-bearing on two of them and not decoration: `within_statutory` is a fact
 * about the moment the request was opened (`returns.ts`), and it decides whether the seller has any
 * say at all. A `requested` case can only exist OUTSIDE the 14 days — inside them the request is
 * approved on arrival — so the one row that shows the אשר/סרב buttons has to be an old order.
 *
 * Every clock is set from the same constants the screens read back (`returns.ts`), so a deadline
 * line lands where the mechanism would really put it: `approved` has days left, `received` is about
 * to auto-refund, `offered` is waiting on an answer.
 */
const SCENARIOS = [
  {
    key: 'requested', status: 'requested', reason: 'changed_mind', deliveredDaysAgo: 25,
    openedDaysAgo: 1, withinStatutory: false,
    note: 'ראיתי את זה אצל חבר ואני כבר לא צריך אותו.',
    what: 'בקשה חדשה מחוץ ל-14 יום — אתה מחליט: אשר או סרב, ויש לך שעון',
    where: 'מוכר',
  },
  {
    key: 'approved', status: 'approved', reason: 'damaged', deliveredDaysAgo: 3,
    openedDaysAgo: 2, approvedDaysAgo: 2, withinStatutory: true,
    note: 'הידית הגיעה שבורה, מצרפת תמונה.',
    what: 'אושר אוטומטית (בתוך 14 יום, אין לך מה להחליט). הקונה אמור לשלוח — ואתה יכול להציע כסף במקום',
    where: 'מוכר + קונה',
  },
  {
    key: 'offered', status: 'offered', reason: 'damaged', deliveredDaysAgo: 6,
    openedDaysAgo: 5, approvedDaysAgo: 5, offeredDaysAgo: 2, offerFraction: 0.4,
    withinStatutory: true, note: 'יש שריטה בצד. לא נורא אם מפצים אותי.',
    what: 'הצעת החזר חלקי במקום החזרה. הכדור אצל הקונה, ויש לו שעון',
    where: 'מוכר + קונה',
  },
  {
    key: 'in_transit', status: 'in_transit', reason: 'wrong_item', deliveredDaysAgo: 9,
    openedDaysAgo: 8, approvedDaysAgo: 8, sentDaysAgo: 3, withinStatutory: true,
    tracking: 'IL480021977', note: 'הזמנתי מידה L והגיע S.',
    what: 'הקונה הצהיר ששלח. זו הצהרה ולא הוכחה — רק "המוצר הגיע אליי" משלם',
    where: 'מוכר',
  },
  {
    key: 'received', status: 'received', reason: 'wrong_item', deliveredDaysAgo: 12,
    openedDaysAgo: 11, approvedDaysAgo: 11, sentDaysAgo: 6, receivedDaysAgo: 1,
    withinStatutory: true, note: 'הגיע דגם אחר לגמרי.',
    what: 'החבילה חזרה אליך. אם לא תעשה כלום — הכסף חוזר לקונה אוטומטית',
    where: 'מוכר',
  },
  {
    key: 'partial', status: 'received', reason: 'damaged', deliveredDaysAgo: 12,
    openedDaysAgo: 10, approvedDaysAgo: 10, sentDaysAgo: 5, receivedDaysAgo: 1,
    withinStatutory: true, partialLines: true, note: 'רק אחד מהשניים הגיע פגום.',
    what: 'החזרה חלקית — שורה אחת מתוך כמה. ההזמנה עצמה נשארת "נמסרה"',
    where: 'מוכר',
  },
  {
    key: 'disputed', status: 'disputed', reason: 'damaged', deliveredDaysAgo: 20,
    openedDaysAgo: 16, approvedDaysAgo: 16, sentDaysAgo: 10, receivedDaysAgo: 4,
    disputedDaysAgo: 3, withinStatutory: true, note: 'המסך הגיע סדוק.',
    sellerNote: 'החבילה הגיעה ריקה — רק הקרטון.',
    what: 'אמרת שהחבילה הגיעה ריקה. כל השעונים עצרו, ואנחנו מכריעים',
    where: 'אדמין (זו השורה היחידה שדורשת אותך)',
  },
  {
    key: 'rejected', status: 'rejected', reason: 'changed_mind', deliveredDaysAgo: 30,
    openedDaysAgo: 6, settledDaysAgo: 5, withinStatutory: false,
    note: 'התחרטתי.', sellerNote: 'עברו יותר מ-14 יום מהמסירה.',
    what: 'סירבת. לקונה יש חלון לערער — ואז זה מגיע אליך כמחלוקת',
    where: 'מוכר (היסטוריה) + קונה',
  },
  {
    key: 'refunded', status: 'refunded', reason: 'damaged', deliveredDaysAgo: 34,
    openedDaysAgo: 20, approvedDaysAgo: 20, sentDaysAgo: 15, receivedDaysAgo: 12,
    settledDaysAgo: 11, withinStatutory: true, note: 'הגיע שבור.',
    what: 'נסגר בהחזר. הכסף עדיין לא הועבר בפועל — אין ספק סליקה, וזה מופיע כחוב באדמין',
    where: 'מוכר (היסטוריה) + אדמין → יומן כספי',
  },
  {
    key: 'expired', status: 'expired', reason: 'changed_mind', deliveredDaysAgo: 40,
    openedDaysAgo: 30, approvedDaysAgo: 30, settledDaysAgo: 22, withinStatutory: true,
    note: 'רוצה להחזיר.',
    what: 'אושר והקונה מעולם לא שלח. נסגר לטובתך ביום ה-7, בלי שנגעת',
    where: 'מוכר (היסטוריה)',
  },
];

async function main() {
  const db = await openSeedClient();
  try {
    await db.query('BEGIN');
    const removed = await purgeReturnDemo(db);
    if (CLEAN) {
      await db.query('COMMIT');
      console.log(`\n🧹 הוסרו ${removed.requests} תרחישי החזרה ו-${removed.orders} הזמנות ההדגמה שלהם.\n`);
      return;
    }

    // Demo stores only, and the shop has to have something to sell — a scenario needs real line
    // items or every screen shows an empty order.
    const { rows: stores } = STORE_FLAG
      ? await db.query(
        `SELECT id, slug, name FROM stores WHERE slug = $1 AND deleted_at IS NULL`, [STORE_FLAG])
      : await db.query(
        `SELECT s.id, s.slug, s.name
           FROM stores s
           JOIN sellers se ON se.id = s.seller_id
          WHERE se.email LIKE '%' || $1
            AND s.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM store_products p WHERE p.store_id = s.id AND NOT p.hidden)
          ORDER BY s.slug`,
        [DEMO_EMAIL_SUFFIX]);
    if (!stores.length) {
      await db.query('ROLLBACK');
      console.log(STORE_FLAG
        ? `\n⚠️  אין חנות בשם "${STORE_FLAG}".\n`
        : '\n⚠️  אין חנויות דמו עם מוצרים. קודם:  npm run seed:demo'
          + '\n   או תרחישים בחנות שלך:  npm run seed:returns -- --store <slug>\n');
      return;
    }

    const buyerId = await ensureBuyer(db);
    const seeded = [];

    for (const [i, sc] of SCENARIOS.entries()) {
      // Spread across the demo shops, so the seller tab of more than one of them has something in
      // it — a demo where every case sits in one store teaches nothing about the tab badge.
      const store = stores[i % stores.length];
      const { rows: products } = await db.query(
        `SELECT id, name, slug, price_agorot, (SELECT url FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS image
           FROM store_products p
          WHERE store_id = $1 AND NOT hidden AND NOT blocked
          ORDER BY created_at DESC
          LIMIT 2`, [store.id]);
      if (!products.length) continue;

      // The partial case needs more than one line, or "one line out of several" has nothing to be a
      // fraction of and the screens correctly render it as a whole-order return.
      const lines = sc.partialLines ? products : products.slice(0, 1);
      const orderId = await writeOrder(db, { store, lines, buyerId, sc, index: i });
      const refundAgorot = await requestRefundAgorot(db, orderId, sc);
      await writeRequest(db, { orderId, store, sc, refundAgorot });
      seeded.push({ sc, store, orderId, refundAgorot });
    }

    await db.query('COMMIT');
    report(seeded);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

/**
 * The buyer these orders belong to — created once and reused, so re-running the seeder does not
 * leave him with two accounts and half his history in each.
 *
 * `ON CONFLICT … DO UPDATE` on the password rather than `DO NOTHING`: the point of the account is
 * that he can sign in, and an account whose password is whatever a previous run happened to write
 * is one he cannot.
 */
async function ensureBuyer(db) {
  const { rows } = await db.query(
    `INSERT INTO sellers (id, name, email, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [crypto.randomUUID(), 'קונה לדוגמה', BUYER_EMAIL, hashPassword(PASSWORD)]);
  return rows[0].id;
}

/**
 * One delivered, paid order for a scenario to hang from.
 *
 * `delivered_at` is the column `withinStatutoryWindow` measures from, and `paid_at`/`shipped_at` are
 * what the payout hold reads — an order missing them behaves like one nobody ever fulfilled, which
 * is a different demo from the one being staged here.
 *
 * The `payment_ref` is the mark: `RETURN_DEMO_PAYMENT_REF` is a prefix nothing else on the platform
 * writes, and it is the entire predicate `purgeReturnDemo` deletes by. The column is UNIQUE, so the
 * index makes each run's refs distinct without a counter to keep.
 */
async function writeOrder(db, { store, lines, buyerId, sc, index }) {
  const orderId = crypto.randomUUID();
  const subtotal = lines.reduce((sum, p) => sum + Number(p.price_agorot), 0);
  const shipping = 2900;
  await db.query(
    `INSERT INTO orders (id, checkout_ref, buyer_id, buyer_name, buyer_email, buyer_phone,
                         buyer_city, buyer_street, buyer_zip, shipping_agorot, total_agorot,
                         payment_ref, payment_status, shipping_status, tracking_number,
                         created_at, updated_at, paid_at, shipped_at, delivered_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'paid','delivered',$13,$14,$15,$14,$16,$17)`,
    [orderId, `${RETURN_DEMO_PAYMENT_REF}${index}`, buyerId, 'קונה לדוגמה', BUYER_EMAIL, '0500000000',
     'תל אביב', 'אבן גבירול 30', '6100000', shipping, subtotal + shipping,
     `${RETURN_DEMO_PAYMENT_REF}${index}`, `IL${100000000 + index}`,
     iso((sc.deliveredDaysAgo + 3) * DAY), iso(sc.deliveredDaysAgo * DAY),
     iso((sc.deliveredDaysAgo + 1) * DAY), iso(sc.deliveredDaysAgo * DAY)]);

  await db.query(
    `INSERT INTO order_items (id, order_id, product_id, product_name, product_slug, store_slug,
                              store_name, price_agorot, qty, image, position)
     SELECT unnest($1::uuid[]), $2, unnest($3::uuid[]), unnest($4::text[]), unnest($5::text[]),
            $6, $7, unnest($8::bigint[]), 1, unnest($9::text[]), generate_series(0, $10)`,
    [lines.map(() => crypto.randomUUID()), orderId, lines.map((p) => p.id), lines.map((p) => p.name),
     lines.map((p) => p.slug), store.slug, store.name, lines.map((p) => p.price_agorot),
     lines.map((p) => p.image ?? null), lines.length - 1]);

  await db.query(
    `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot)
     VALUES ($1,$2,$3,$4,$5)`,
    [orderId, store.slug, store.name, subtotal, shipping]);
  return orderId;
}

/**
 * What comes back, computed the way `returns.ts#refundForRequest` computes it.
 *
 * Restated here rather than imported, because this is a `.mjs` script and the rule is a TypeScript
 * module — and restated in the SMALLEST form that is still true, so the difference is visible if it
 * ever drifts: the goods always, plus the original shipping when the fault was the seller's
 * (anything other than `changed_mind`), and only the returned lines on a partial.
 */
async function requestRefundAgorot(db, orderId, sc) {
  const { rows } = await db.query(
    'SELECT price_agorot, qty, position FROM order_items WHERE order_id = $1 ORDER BY position', [orderId]);
  const { rows: [o] } = await db.query('SELECT shipping_agorot FROM orders WHERE id = $1', [orderId]);
  if (sc.partialLines) {
    const line = rows[0];
    return Number(line.price_agorot) * Number(line.qty);
  }
  const goods = rows.reduce((sum, r) => sum + Number(r.price_agorot) * Number(r.qty), 0);
  return goods + (sc.reason === 'changed_mind' ? 0 : Number(o.shipping_agorot));
}

/** The case itself, posed in its state with every clock the screens read already set. */
async function writeRequest(db, { orderId, store, sc, refundAgorot }) {
  const at = (days) => (days === undefined ? null : iso(days * DAY));
  await db.query(
    `INSERT INTO return_requests
       (id, order_id, store_slug, reason, buyer_note, status, within_statutory,
        return_shipping_payer, refund_agorot, partial_offer_agorot, returned_lines,
        tracking_number, seller_note, created_at, approved_at, sent_at, offered_at,
        delivered_back_at, closed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())`,
    [crypto.randomUUID(), orderId, store.slug, sc.reason, sc.note, sc.status, sc.withinStatutory,
     sc.reason === 'changed_mind' ? 'buyer' : 'seller', refundAgorot,
     sc.offerFraction ? Math.round(refundAgorot * sc.offerFraction) : null,
     sc.partialLines ? JSON.stringify([{ position: 0, qty: 1 }]) : null,
     sc.tracking ?? null, sc.sellerNote ?? '',
     at(sc.openedDaysAgo), at(sc.approvedDaysAgo), at(sc.sentDaysAgo), at(sc.offeredDaysAgo),
     at(sc.receivedDaysAgo), at(sc.settledDaysAgo)]);
}

/**
 * The map — and it is half the deliverable.
 *
 * A seeder that writes ten rows and says "done" leaves exactly the problem it was written for: rows
 * exist somewhere and nobody knows where to look. So every line names the screen, the account and
 * what the case is FOR, in the order they are worth opening.
 */
function report(seeded) {
  const money = (agorot) => `₪${(agorot / 100).toFixed(2)}`;
  console.log(`\n✅ ${seeded.length} תרחישי החזרה נכתבו. כל אחד על הזמנה משלו, שנמסרה, ושולמה.\n`);
  console.log('   כניסות:');
  console.log(`     מוכר   — <slug>${DEMO_EMAIL_SUFFIX}  /  ${PASSWORD}    →  /seller/dashboard → החזרות`);
  console.log(`     קונה   — ${BUYER_EMAIL}  /  ${PASSWORD}    →  /buyer/dashboard`);
  console.log('     אדמין  — /admin → החזרות\n');
  for (const { sc, store, refundAgorot } of seeded) {
    console.log(`   ${sc.status.padEnd(11)} ${money(refundAgorot).padStart(9)}  ${store.slug}`);
    console.log(`      ${sc.what}`);
    console.log(`      איפה רואים: ${sc.where}\n`);
  }
  console.log('   שים לב: בקשות שנסגרו (סורב / הוחזר / פג תוקף) מוסתרות עד שלוחצים');
  console.log('   "הצג גם בקשות שנסגרו" בלשונית ההחזרות.\n');
  console.log('   להסיר:  npm run seed:returns -- --clean\n');
}

main().catch((e) => { console.error('returns seed failed:', e); process.exit(1); });
