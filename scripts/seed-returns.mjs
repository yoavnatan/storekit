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

/** The fulfilment steps in order, so a seeded order's timestamps can be asked "did it get this far"
 *  instead of each scenario hand-listing which stamps it wants. `cancelled` sits where it happened:
 *  a cancelled order was paid and packed and never shipped. */
const ORDER_STEPS = ['pending', 'processing', 'ready', 'cancelled', 'shipped', 'delivered'];
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

  // ── CANCELLATIONS ──
  //
  // A different act from a return and the distinction is the whole of decisions §0: nothing ever
  // reached the buyer, so there is nothing to send back, no postage to argue about and no seller
  // discretion. They carry NO return request — a cancellation is a move on the ORDER — which is why
  // they were missing from a board built around `return_requests` (owner, 2026-08-20: *"תשים לי עוד
  // תרחישים כך שיכסו כל אפשרות וצירוף של ביטול או החזרה"*).
  //
  // The four live ones are the whole of `cancellableFrom` in `order-status-rules.ts` plus the one
  // status that is deliberately NOT in it, which is the case he asked about by name.
  {
    key: 'cancel-pending', kind: 'cancel', orderStatus: 'pending', deliveredDaysAgo: 1,
    what: 'שולם ועוד לא נגעת בה. הקונה יכול לבטל לבד, ואתה תראה את זה כבוטלה',
    where: 'מוכר → הזמנות · קונה (יש לו כפתור ביטול)',
  },
  {
    key: 'cancel-processing', kind: 'cancel', orderStatus: 'processing', deliveredDaysAgo: 2,
    what: 'התחלת לארוז והקונה עדיין יכול לבטל. זה המקרה שעולה לך עבודה',
    where: 'מוכר → הזמנות · קונה (יש לו כפתור ביטול)',
  },
  {
    key: 'cancel-ready', kind: 'cancel', orderStatus: 'ready', deliveredDaysAgo: 3,
    what: 'ממתינה לאיסוף עצמי — עדיין ניתנת לביטול, כי היא לא יצאה לדרך',
    where: 'מוכר → הזמנות · קונה (יש לו כפתור ביטול)',
  },
  {
    key: 'cancel-too-late', kind: 'cancel', orderStatus: 'shipped', deliveredDaysAgo: 2,
    what: 'כבר נשלחה — אי אפשר לבטל. הקונה רואה משפט שמסביר לו לחכות ואז לבקש החזרה',
    where: 'קונה → ההזמנות שלי (זה המסך שביקשת לראות)',
  },
  {
    key: 'cancelled-done', kind: 'cancel', orderStatus: 'cancelled', deliveredDaysAgo: 6,
    what: 'בוטלה אחרי שהכסף כבר נגבה. יצאה מכל חישובי ההכנסה, והכסף רשום כחוב לקונה',
    where: 'מוכר → הזמנות · אדמין → יומן כספי',
  },

  // ── The return combinations the first ten did not reach ──
  {
    key: 'approved-late', status: 'approved', reason: 'changed_mind', deliveredDaysAgo: 22,
    openedDaysAgo: 4, approvedDaysAgo: 3, withinStatutory: false,
    note: 'יודע שעברו 14 יום, אשמח אם תסכים.',
    what: 'מחוץ ל-14 יום ואישרת בכל זאת — טובה שלך, לא חובה. שים לב שהמשלוח חזרה על חשבונו',
    where: 'מוכר',
  },
  {
    key: 'not-arrived', status: 'approved', reason: 'not_arrived', deliveredDaysAgo: 11,
    openedDaysAgo: 5, approvedDaysAgo: 5, withinStatutory: true,
    note: 'החבילה מעולם לא הגיעה אליי.',
    what: 'החבילה לא הגיעה. אין מוצר לשלוח בחזרה — זה מקרה שאנחנו מטפלים בו מול חברת המשלוחים',
    where: 'מוכר',
  },
  {
    key: 'escalated', status: 'disputed', reason: 'changed_mind', deliveredDaysAgo: 26,
    openedDaysAgo: 9, settledDaysAgo: undefined, disputedDaysAgo: 2, withinStatutory: false,
    note: 'סירבת לי ואני חושב שזה לא הוגן.',
    sellerNote: 'עברו יותר מ-14 יום.',
    what: 'סירבת, והקונה ביקש שנבדוק. זה הכיוון השני להכרעה — לא רק חבילה ריקה',
    where: 'אדמין (דורש אותך)',
  },
  {
    key: 'partial-two', status: 'received', reason: 'wrong_item', deliveredDaysAgo: 13,
    openedDaysAgo: 9, approvedDaysAgo: 9, sentDaysAgo: 4, receivedDaysAgo: 1,
    withinStatutory: true, partialLines: 2,
    note: 'שניים מתוך השלושה לא מה שהזמנתי.',
    what: 'החזרה חלקית של שתי שורות מתוך שלוש — לבדוק שהסכום והרשימה תואמים',
    where: 'מוכר',
  },
  {
    key: 'expired-offer', status: 'expired', reason: 'damaged', deliveredDaysAgo: 30,
    openedDaysAgo: 24, approvedDaysAgo: 24, offeredDaysAgo: 18, offerFraction: 0.3,
    settledDaysAgo: 10, withinStatutory: true, note: 'יש פגם קטן.',
    what: 'הצעת סכום והקונה לא ענה כלל. נסגר לטובתך — אבל הוא רשאי לפתוח בקשה חדשה',
    where: 'מוכר (היסטוריה)',
  },
  {
    key: 'in-store', status: 'received', reason: 'damaged', deliveredDaysAgo: 8,
    openedDaysAgo: 4, approvedDaysAgo: 4, receivedDaysAgo: 1, withinStatutory: true,
    note: 'אביא לחנות.', noTracking: true,
    what: 'הקונה הביא את המוצר לחנות ביד — בלי שליח, בלי מספר מעקב. ההוכחה הכי חזקה שיש',
    where: 'מוכר',
  },
  {
    key: 'multi-store', status: 'requested', reason: 'wrong_item', deliveredDaysAgo: 19,
    openedDaysAgo: 1, withinStatutory: false, alsoOtherStore: true,
    note: 'רק הפריט שלכם לא תואם.',
    what: 'עגלה משותפת עם חנות אחרת — ההחזרה היא על הפרוסה שלך בלבד, והשנייה לא אמורה לראות כלום',
    where: 'מוכר',
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
      // The named shop FIRST, and its owner's other shops after it. Only the first is staged on —
      // `stores[i % stores.length]` is bypassed below for the flag path — but the shared-cart
      // scenario needs a second slug to put the other slice under, and inventing one would
      // demonstrate the opposite of what that case is for.
      ? await db.query(
        `SELECT id, slug, name FROM stores
          WHERE deleted_at IS NULL
            AND (slug = $1 OR seller_id = (SELECT seller_id FROM stores WHERE slug = $1))
          ORDER BY (slug = $1) DESC, slug`, [STORE_FLAG])
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
    const skipped = [];

    for (const [i, sc] of SCENARIOS.entries()) {
      // Spread across the demo shops, so the seller tab of more than one of them has something in
      // it — a demo where every case sits in one store teaches nothing about the tab badge.
      // Spread across the demo shops so more than one tab has something in it — but when a shop was
      // NAMED, every case belongs to it and the others are only there to be the other half of a
      // shared cart.
      const store = STORE_FLAG ? stores[0] : stores[i % stores.length];
      const products = await productsOf(db, store.id, 3);
      if (!products.length) continue;

      // A partial names how many of the order's lines come back, so the order needs at least one
      // more than that — "one out of several" has nothing to be a fraction of otherwise, and the
      // screens correctly render it as a whole-order return.
      const wanted = sc.partialLines ? Number(sc.partialLines) + 1 : 1;
      const lines = products.slice(0, Math.min(wanted, products.length));

      // A cart shared with another shop. It is the one scenario that needs a SECOND store, and it is
      // skipped rather than faked when there is only one: an invented second slice would demonstrate
      // the opposite of what it is for, which is that a seller sees his own slice and nothing else.
      const otherStore = sc.alsoOtherStore ? stores.find((st) => st.slug !== store.slug) : null;
      if (sc.alsoOtherStore && !otherStore) { skipped.push(sc); continue; }
      const otherLines = otherStore ? (await productsOf(db, otherStore.id, 1)) : [];

      const orderId = await writeOrder(db, { store, lines, buyerId, sc, index: i, otherStore, otherLines });

      // A CANCELLATION is a move on the order and carries no case — that is decisions §0, and it is
      // the whole reason these were missing from a board built around `return_requests`.
      if (sc.kind === 'cancel') {
        seeded.push({ sc, store, orderId, refundAgorot: null });
        continue;
      }
      const refundAgorot = await requestRefundAgorot(db, orderId, sc, store.slug);
      await writeRequest(db, { orderId, store, sc, refundAgorot });
      seeded.push({ sc, store, orderId, refundAgorot });
    }

    await db.query('COMMIT');
    report(seeded, skipped);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

/** The shop's newest sellable products — the lines a scenario's order is built from. */
async function productsOf(db, storeId, limit) {
  const { rows } = await db.query(
    `SELECT id, name, slug, price_agorot,
            (SELECT url FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS image
       FROM store_products p
      WHERE store_id = $1 AND NOT hidden AND NOT blocked
      ORDER BY created_at DESC
      LIMIT $2`, [storeId, limit]);
  return rows;
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
async function writeOrder(db, { store, lines, buyerId, sc, index, otherStore, otherLines = [] }) {
  const orderId = crypto.randomUUID();
  const subtotal = lines.reduce((sum, p) => sum + Number(p.price_agorot), 0);
  const otherSubtotal = otherLines.reduce((sum, p) => sum + Number(p.price_agorot), 0);
  const shipping = 2900;
  // ── The status, and the timestamps that must MATCH it ──
  //
  // A cancellation scenario is an order that never arrived, so `delivered_at` has to be null or the
  // statutory window would be measured from a delivery that did not happen
  // (`returns.ts#withinStatutoryWindow` reads exactly that column). Same for `shipped_at` on an
  // order still being packed: a stamp for a step that has not run is the seeded equivalent of a
  // status that lies, and every screen downstream would believe it.
  const status = sc.orderStatus ?? 'delivered';
  const reached = (step) => ORDER_STEPS.indexOf(status) >= ORDER_STEPS.indexOf(step);
  const daysAgo = sc.deliveredDaysAgo;
  await db.query(
    `INSERT INTO orders (id, checkout_ref, buyer_id, buyer_name, buyer_email, buyer_phone,
                         buyer_city, buyer_street, buyer_zip, shipping_agorot, total_agorot,
                         payment_ref, payment_status, shipping_status, tracking_number,
                         created_at, updated_at, paid_at, shipped_at, delivered_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'paid',$13,$14,$15,$16,$17,$18,$19)`,
    [orderId, `${RETURN_DEMO_PAYMENT_REF}${index}`, buyerId, 'קונה לדוגמה', BUYER_EMAIL, '0500000000',
     'תל אביב', 'אבן גבירול 30', '6100000', shipping, subtotal + otherSubtotal + shipping,
     `${RETURN_DEMO_PAYMENT_REF}${index}`, status,
     reached('shipped') ? `IL${100000000 + index}` : null,
     iso((daysAgo + 3) * DAY), iso(daysAgo * DAY),
     iso((daysAgo + 3) * DAY),
     reached('shipped') ? iso((daysAgo + 1) * DAY) : null,
     reached('delivered') ? iso(daysAgo * DAY) : null]);

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

  // The other shop's slice of the same purchase — one order, two `order_stores` rows, which is what
  // a multi-store checkout really writes. Its lines start where this store's end, because `position`
  // is the receipt order for the WHOLE order and a partial return names lines by it.
  if (otherStore && otherLines.length) {
    await db.query(
      `INSERT INTO order_items (id, order_id, product_id, product_name, product_slug, store_slug,
                                store_name, price_agorot, qty, image, position)
       SELECT unnest($1::uuid[]), $2, unnest($3::uuid[]), unnest($4::text[]), unnest($5::text[]),
              $6, $7, unnest($8::bigint[]), 1, unnest($9::text[]),
              generate_series($10::int, $10::int + $11::int)`,
      [otherLines.map(() => crypto.randomUUID()), orderId, otherLines.map((x) => x.id),
       otherLines.map((x) => x.name), otherLines.map((x) => x.slug), otherStore.slug, otherStore.name,
       otherLines.map((x) => x.price_agorot), otherLines.map((x) => x.image ?? null),
       lines.length, otherLines.length - 1]);
    await db.query(
      `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot)
       VALUES ($1,$2,$3,$4,0)`,
      [orderId, otherStore.slug, otherStore.name, otherSubtotal]);
  }
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
async function requestRefundAgorot(db, orderId, sc, storeSlug) {
  // THIS store's lines only. On a shared cart the other shop's items are in the same order and are
  // not this seller's to refund — the same boundary `scopeOrder` draws one screen over.
  const { rows } = await db.query(
    `SELECT price_agorot, qty, position FROM order_items
      WHERE order_id = $1 AND store_slug = $2 ORDER BY position`, [orderId, storeSlug]);
  const { rows: [o] } = await db.query('SELECT shipping_agorot FROM orders WHERE id = $1', [orderId]);
  if (sc.partialLines) {
    const back = rows.slice(0, Number(sc.partialLines));
    return back.reduce((sum, l) => sum + Number(l.price_agorot) * Number(l.qty), 0);
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
     sc.partialLines
       ? JSON.stringify(Array.from({ length: Number(sc.partialLines) }, (_, i) => ({ position: i, qty: 1 })))
       : null,
     // An in-store handover has no tracking number BY CONSTRUCTION — nothing was posted. Seeding one
     // would demonstrate the opposite of the case it is there to show.
     sc.noTracking ? null : (sc.tracking ?? null), sc.sellerNote ?? '',
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
function report(seeded, skipped = []) {
  const money = (agorot) => `₪${(agorot / 100).toFixed(2)}`;
  const cancels = seeded.filter((x) => x.sc.kind === 'cancel');
  const returns = seeded.filter((x) => x.sc.kind !== 'cancel');

  console.log(`\n✅ ${seeded.length} תרחישים נכתבו — ${returns.length} החזרות ו-${cancels.length} ביטולים. כל אחד על הזמנה משלו.\n`);
  console.log('   כניסות:');
  console.log(`     מוכר   — <slug>${DEMO_EMAIL_SUFFIX}  /  ${PASSWORD}    →  /seller/dashboard`);
  console.log(`     קונה   — ${BUYER_EMAIL}  /  ${PASSWORD}    →  /buyer/dashboard`);
  console.log('     אדמין  — /admin\n');

  // Grouped, because they are two different ACTS and live on two different screens (decisions §0).
  // A single flat list would have the reader hunting for which of them is even in the returns tab.
  // ── The ORDER NUMBER is what makes this list usable, and it was missing ──
  //
  // The board is 22 rows now, and the report named each one by its STATUS — of which there are nine,
  // so five of the words appear two and three times over. Standing in front of the returns tab there
  // was no way to tell which `received` card was the partial and which was the in-store handover
  // (owner, 2026-08-20: *"אני לא מבין בעצם עכשיו איזה תרחיש יש לכל דמו דאטה, איך אדע?"*).
  //
  // Eight characters of the order id is the answer, because it is the one string that is BOTH on the
  // card and in the tab's search box: paste it and the list filters to that single scenario. Printed
  // for the cancellations too, where the same id is what the orders tab searches by.
  const section = (title, rows, label) => {
    if (!rows.length) return;
    console.log(`   ── ${title} ──\n`);
    for (const { sc, store, orderId, refundAgorot } of rows) {
      const amount = refundAgorot === null ? '' : money(refundAgorot).padStart(9);
      console.log(`   ${label(sc).padEnd(13)} ${orderId.slice(0, 8)} ${amount}  ${store.slug}`);
      console.log(`      ${sc.what}`);
      console.log(`      איפה רואים: ${sc.where}\n`);
    }
  };
  section('החזרות', returns, (sc) => sc.status);
  section('ביטולים — אין להם בקשת החזרה, הם מצב של ההזמנה', cancels, (sc) => sc.orderStatus);

  // A scenario the data could not support is NAMED. Dropping it silently would leave the board
  // looking complete while the one case it could not build is the one nobody then checks.
  if (skipped.length) {
    console.log('   ⚠️  לא נכתבו — אין מספיק נתונים בחנות:');
    for (const sc of skipped) console.log(`      ${sc.key} — ${sc.what}`);
    console.log('      (עגלה משותפת דורשת חנות שנייה. הריצו עם חנות אחרת, או npm run seed:demo.)\n');
  }

  console.log('   שים לב: בקשות שנסגרו (סורב / הוחזר / פג תוקף) מוסתרות עד שמסמנים');
  console.log('   "הצג גם בקשות שנסגרו" בלשונית ההחזרות.');
  console.log('   כדי לבודד תרחיש אחד: העתק את מספר ההזמנה שלו לתיבת החיפוש בלשונית.\n');
  console.log('   להסיר:  npm run seed:returns -- --clean\n');
}

main().catch((e) => { console.error('returns seed failed:', e); process.exit(1); });
