#!/usr/bin/env node
/**
 * Reviews for the showcase stores — so the ratings can be LOOKED AT before the platform has sold
 * anything (owner asked, 2026-08-17).
 *
 *   npm run seed:reviews             # add them
 *   npm run seed:reviews -- --clean  # remove them and everything they needed
 *
 * ── Its own script, AND run automatically at the end of `seed:showcase` (2026-08-17) ──
 * A review cannot exist without a purchase — that is the whole feature (`review-eligibility.ts`),
 * and a seeder does not get a shortcut the product does not have. So this writes ORDERS, and those
 * orders are money: they land in the platform statement, in the reconciliation card and in the
 * seller's own balance, none of which filter demo stores today. That is why it stayed out of
 * `seed:showcase` at first.
 *
 * It could not stay out. `product_reviews` cascades from `store_products`, so every `seed:showcase`
 * — which purges and rewrites those stores — silently deleted every seeded review with them. It
 * happened twice in one afternoon from parallel sessions, and each time the ratings simply vanished
 * from the site with nothing to say so. A demo whose content evaporates whenever somebody reseeds
 * is not a demo.
 *
 * So `seedShowcaseReviews` is exported and the showcase seeder calls it last, after the stores it
 * depends on exist. What keeps the fabricated money out of production is not the separation any
 * more — it is the ⚠️ line in GO_LIVE §2.7: `npm run seed:reviews -- --clean` before the site opens,
 * which removes every row this wrote in one command.
 *
 * ── The purge gate ──
 * Everything written here is tagged by the buyer's email suffix, and `--clean` deletes by exactly
 * that tag — never by store, never by date. So it cannot reach an order a real person placed, which
 * is the same guarantee `seed-db.mjs`'s own purge gate exists to give.
 */
import crypto from 'node:crypto';
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { SEEDED_REVIEW_EMAIL_SUFFIX as SUFFIX, purgeSeededReviews } from './lib/seed-db.mjs';

const CLEAN = process.argv.includes('--clean');

/** Deterministic, so a re-run produces the same catalogue of opinions. */
let _s = 20260817;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const FIRST = ['נועה', 'איתי', 'שירה', 'עומר', 'תמר', 'יונתן', 'מאיה', 'אורי', 'ליאור', 'רוני', 'דנה', 'אסף'];
const INITIAL = ['א׳', 'ב׳', 'ג׳', 'ל׳', 'מ׳', 'נ׳', 'ס׳', 'פ׳', 'ר׳', 'ש׳'];

/** Ordinary sentences. A demo whose reviews all rave reads as marketing copy, which is the one
 *  thing a review must never look like. */
const BODIES = [
  'הגיע מהר ובאריזה טובה. בדיוק כמו בתמונות.',
  'איכות מצוינת ביחס למחיר, אקנה שוב.',
  'יפה מאוד, אבל קצת יותר קטן ממה שציפיתי.',
  'שירות אדיב והמוצר תקין. ממליץ.',
  'סביר. לא רע, לא מדהים.',
  'הגיע יומיים אחרי ההזמנה, ארוז יפה.',
  'שווה כל שקל. כבר הזמנתי עוד אחד למתנה.',
  'המידה קצת גדולה, שווה לבדוק לפני שמזמינים.',
  'בדיוק מה שחיפשתי לבית.',
  'הצבע במציאות קצת שונה מהתמונה, אבל עדיין יפה.',
  'עמיד ונוח לשימוש יומיומי.',
  'הגיע פגום, אבל החליפו לי בלי ויכוח.',
];

/** Skewed high, like a real catalogue's — but not uniformly 5, or the half star and the
 *  distribution bar never render at all, which is exactly what needs to be seen. */
const RATINGS = [5, 5, 5, 5, 4, 4, 4, 4, 3, 3, 2, 1];

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('\n❌ DATABASE_URL is not set.\n'); process.exit(1); }
  const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await seedShowcaseReviews(db, { clean: CLEAN });
  } finally {
    await db.end();
  }
}

/**
 * The work, on a client somebody else opened — so `seed-showcase-stores.mjs` can run it inside its
 * own connection right after writing the stores, and the ratings are never left behind by a reseed.
 *
 * Its own transaction: the showcase seeder has already committed by the time this runs, and a
 * failure here must not take those stores down with it. Worst case is stores with no ratings, which
 * is exactly the state a re-run fixes.
 */
export async function seedShowcaseReviews(db, { clean = false, quiet = false } = {}) {
  const say = (...a) => { if (!quiet) console.log(...a); };
  try {
    await db.query('BEGIN');

    // A re-run replaces the previous set rather than stacking a second one on top. The delete
    // itself belongs to `seed-db.mjs` — a seeder names what it disposes of and never writes its
    // own WHERE (tests/seed-purge-gate.test.ts).
    const removed = await purgeSeededReviews(db);

    if (clean) {
      await recompute(db);
      await db.query('COMMIT');
      say(`\n✅ Removed ${removed} seeded order(s) and every review on them.\n`);
      return;
    }

    // Showcase stores only: they are the ones with no sales of their own, and they are the set a
    // `--clean` can safely be scoped to. A real seller's store is never touched.
    const { rows: stores } = await db.query(
      `SELECT id, slug, name FROM stores
        WHERE demo = true AND NOT blocked AND deleted_at IS NULL
        ORDER BY slug`);
    if (!stores.length) {
      await db.query('ROLLBACK');
      say('\n⚠️  No showcase stores found — nothing to review. Run `npm run seed:showcase` first.\n');
      return;
    }

    let orderN = 0;
    let reviewN = 0;
    const rated = [];

    for (const store of stores) {
      // A handful of products per store, and DELIBERATELY not all of them: a catalogue where every
      // single product carries a rating is the one thing a real shop never looks like, and the
      // unrated ones are half of what needs checking (they must show nothing at all).
      const { rows: products } = await db.query(
        `SELECT id, slug, name, price_agorot FROM store_products
          WHERE store_id = $1 AND NOT hidden AND NOT blocked
          ORDER BY created_at DESC, id
          LIMIT 6`, [store.id]);

      for (const [index, product] of products.entries()) {
        // A spread: the first product of each store gets enough reviews for the distribution bar to
        // say something, the rest taper off to one, and the last one gets none.
        const count = index === 0 ? int(9, 14) : index === 1 ? int(4, 6) : index >= products.length - 1 ? 0 : int(1, 3);
        if (!count) continue;
        rated.push({ store: store.slug, product: product.slug, count });

        for (let i = 0; i < count; i++) {
          const orderId = crypto.randomUUID();
          const placed = Date.now() - int(6, 120) * DAY;
          const delivered = placed + int(2, 6) * DAY;
          const qty = 1;
          const total = Number(product.price_agorot) * qty;

          await db.query(
            `INSERT INTO orders (id, checkout_ref, buyer_name, buyer_email, buyer_phone,
                                 buyer_city, buyer_street, shipping_agorot, total_agorot,
                                 payment_status, shipping_status, paid_at, delivered_at,
                                 review_invited_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, '0500000000', 'תל אביב', 'הרצל 1', 0, $5,
                     'paid', 'delivered', $6, $7, now(), $6, $7)`,
            [orderId, `RV${String(++orderN).padStart(5, '0')}`, pick(FIRST), `buyer${orderN}${SUFFIX}`,
             total, iso(placed), iso(delivered)]);

          await db.query(
            `INSERT INTO order_items (id, order_id, product_id, product_name, product_slug,
                                      store_slug, store_name, price_agorot, qty, position)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)`,
            [crypto.randomUUID(), orderId, product.id, product.name, product.slug,
             store.slug, store.name, product.price_agorot, qty]);

          await db.query(
            `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot)
             VALUES ($1, $2, $3, $4, 0)`,
            [orderId, store.slug, store.name, total]);

          // `review_invited_at` is stamped above so the invite job never mails these fake
          // addresses — the row is a display fixture, not a person waiting to be asked.
          const rating = pick(RATINGS);
          await db.query(
            `INSERT INTO product_reviews (id, product_id, store_slug, order_id, reviewer_name, rating, body, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [crypto.randomUUID(), product.id, store.slug, orderId,
             `${pick(FIRST)} ${pick(INITIAL)}`, rating,
             // A low rating without a reason is the least useful thing on a review page, so those
             // always carry text; the happy ones sometimes do not, which is also true of real ones.
             rating <= 3 || rnd() < 0.7 ? pick(BODIES) : '',
             iso(delivered + int(1, 10) * DAY)]);
          reviewN++;
        }
      }
    }

    await recompute(db);
    await db.query('COMMIT');

    say(`\n✅ ${reviewN} reviews across ${rated.length} products in ${stores.length} showcase stores.`);
    for (const store of stores) {
      const top = rated.filter((r) => r.store === store.slug).sort((a, b) => b.count - a.count)[0];
      if (top) say(`     /${top.store}/${top.product}   — ${top.count} reviews`);
    }
    say('\n   Remove it all with:  npm run seed:reviews -- --clean\n');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

/** The cached score is a CACHE — rebuilt from the rows, exactly as `recomputeProductRating` does it,
 *  never counted up while inserting. Covers products this run emptied as well as ones it filled. */
async function recompute(db) {
  await db.query(`UPDATE store_products p
                     SET review_count = COALESCE(agg.n, 0), review_rating_sum = COALESCE(agg.total, 0)
                    FROM (SELECT id FROM store_products) all_p
                    LEFT JOIN (SELECT product_id, count(*)::int AS n, sum(rating)::int AS total
                                 FROM product_reviews WHERE NOT blocked GROUP BY product_id) agg
                      ON agg.product_id = all_p.id
                   WHERE p.id = all_p.id`);
}

// Only when run directly — importing this file must not seed anything by itself. Through
// `pathToFileURL`, because argv[1] is whatever the caller typed (`./scripts/…`) and comparing a
// relative path against an absolute URL silently never matches, which is a script that does nothing.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('review seed failed:', e); process.exit(1); });
}
