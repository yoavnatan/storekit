#!/usr/bin/env node
/**
 * The showcase stores' ratings — illustrative, and with no purchase behind them.
 *
 *   npm run seed:reviews             # write them
 *   npm run seed:reviews -- --clean  # remove them
 *
 * Also run automatically at the end of `seed:showcase`, because `product_reviews` cascades from
 * `store_products`: every reseed of those stores deleted the whole set, silently, and it happened
 * twice in one afternoon from parallel sessions. A demo whose content evaporates is not a demo.
 *
 * ── What this used to do, and why it stopped (owner, 2026-08-18) ──
 * `order_id` was NOT NULL, so the first version gave each rating a fabricated ORDER to hang from.
 * That worked and quietly put invented revenue into the accountant's report, the reconciliation
 * card and the platform's own balance — none of which filter demo stores. The choice looked like
 * "no ratings in the shop window" versus "fake money in the books", and the owner rejected the
 * question instead of answering it: *"למה לא לייצר ביקורות דמה שהן רק לשם הדוגמא?"*
 *
 * Migration 0040 is that answer. A review is now either REAL — with the order it belongs to, the
 * guarantee unchanged — or DEMO, with no order at all, and a CHECK constraint keeps the two apart.
 * So this script writes reviews and nothing else: no orders, no order lines, no money, nothing to
 * clean up before going live.
 *
 * ── The purge ──
 * `--clean` and every re-run delete by the `demo` flag, which is the only thing these rows have in
 * common and is set by nothing else on the platform. There is no argument under which it could
 * reach a review a real buyer wrote — the same guarantee `seed-db.mjs`'s own purge gate gives.
 */import crypto from 'node:crypto';
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { purgeDemoReviews } from './lib/seed-db.mjs';

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
    // belongs to `seed-db.mjs` — a seeder names what it disposes of and never writes its own WHERE
    // (tests/seed-purge-gate.test.ts).
    const removed = await purgeDemoReviews(db);

    if (clean) {
      await recompute(db);
      await db.query('COMMIT');
      say(`\n✅ Removed ${removed} demo review(s).\n`);
      return;
    }

    // Showcase stores only. `demo = true` is the same flag that keeps them out of the index, the
    // sitemap, the product feed and checkout — so a rating written here can never reach a real
    // shop, and the review's own `demo` column says so a second time.
    const { rows: stores } = await db.query(
      `SELECT id, slug, name FROM stores
        WHERE demo = true AND NOT blocked AND deleted_at IS NULL
        ORDER BY slug`);
    if (!stores.length) {
      await db.query('ROLLBACK');
      say('\n⚠️  No showcase stores found — nothing to review. Run `npm run seed:showcase` first.\n');
      return;
    }

    let reviewN = 0;
    const rated = [];

    for (const store of stores) {
      // A handful of products per store, DELIBERATELY not all of them: a catalogue where every
      // single product carries a rating is the one thing a real shop never looks like, and the
      // unrated ones are half of what needs checking — they must show nothing at all.
      const { rows: products } = await db.query(
        `SELECT id, slug, name FROM store_products
          WHERE store_id = $1 AND NOT hidden AND NOT blocked
          ORDER BY created_at DESC, id
          LIMIT 6`, [store.id]);

      for (const [index, product] of products.entries()) {
        // A spread: the first product of each store gets enough for the distribution bar to say
        // something, the rest taper to one, and the last gets none.
        const count = index === 0 ? int(9, 14) : index === 1 ? int(4, 6) : index >= products.length - 1 ? 0 : int(1, 3);
        if (!count) continue;
        rated.push({ store: store.slug, product: product.slug, count });

        for (let i = 0; i < count; i++) {
          const rating = pick(RATINGS);
          const ago = int(6, 130);
          await db.query(
            `INSERT INTO product_reviews (id, product_id, store_slug, reviewer_name, rating, body, demo, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, true, now() - ($7 || ' days')::interval)`,
            [crypto.randomUUID(), product.id, store.slug,
             `${pick(FIRST)} ${pick(INITIAL)}`, rating,
             // A low rating with no reason is the least useful thing on a review page, so those
             // always carry text; the happy ones sometimes do not, which is also true of real ones.
             rating <= 3 || rnd() < 0.7 ? pick(BODIES) : '',
             String(ago)]);
          reviewN++;
        }
      }
    }

    await recompute(db);
    await db.query('COMMIT');

    say(`\n✅ ${reviewN} demo reviews across ${rated.length} products in ${stores.length} showcase stores.`);
    for (const store of stores) {
      const top = rated.filter((r) => r.store === store.slug).sort((a, b) => b.count - a.count)[0];
      if (top) say(`     /${top.store}/${top.product}   — ${top.count} reviews`);
    }
    say('\n   Remove them with:  npm run seed:reviews -- --clean\n');
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
