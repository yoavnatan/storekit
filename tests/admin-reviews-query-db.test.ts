import { describe, it, expect, beforeEach } from 'vitest';
import { query, firstRow } from '../src/lib/db.js';
import { createDemoReview, getAdminReviewsPage, countAllReviews, setReviewBlocked } from '../src/lib/product-reviews.js';
import { parseAdminReviewQuery } from '../src/lib/admin-reviews-filter.js';

/**
 * The admin Reviews tab's query, against a real database.
 *
 * **The first assertion here is a bug this file was written because of.** The panel renders the
 * same "לדוגמה" mark the shopper sees, and its own header argues why that matters precisely on this
 * screen — it is the one used to decide whether to take a review down, and 83 seeded ratings that
 * look exactly like buyers' own is the wrong basis for that decision. The old `getRecentReviews`
 * never selected `r.demo`, so the flag arrived `undefined` and the badge had never once rendered.
 * Nothing failed: the column simply was not asked for, the value was falsy, and the mark was absent
 * on every row. A test over the SQL is the only thing that can see that.
 *
 * The rest pins the narrowing, which is the reason the tab exists at all — as a panel it was the
 * newest 25 with no way to ask anything.
 */

const KERAMIKA = '22222222-2222-4222-8222-000000000001';
const TACHSHITIM = '22222222-2222-4222-8222-000000000002';
const KERAMIKA_SELLER = '11111111-1111-4111-8111-000000000001';

const q = (search = '') => parseAdminReviewQuery(new URLSearchParams(search));

async function productIn(storeId: string): Promise<{ id: string; storeSlug: string }> {
  const row = await firstRow<{ id: string; slug: string }>(
    'SELECT p.id, s.slug FROM store_products p JOIN stores s ON s.id = p.store_id WHERE p.store_id = $1 ORDER BY p.id LIMIT 1',
    [storeId],
  );
  return { id: row!.id, storeSlug: row!.slug };
}

/** Every test writes reviews, so each starts from an empty table and leaves it empty. */
beforeEach(async () => {
  await query('DELETE FROM product_reviews');
});

describe('getAdminReviewsPage', () => {
  it('carries the demo flag — the column the old query never selected', async () => {
    const p = await productIn(KERAMIKA);
    await createDemoReview({ productId: p.id, storeSlug: p.storeSlug, buyerFullName: 'דנה כהן', rating: 5, body: 'מעולה' });

    const page = await getAdminReviewsPage(q(), 0, 15);

    expect(page.reviews).toHaveLength(1);
    expect(page.reviews[0]!.demo).toBe(true);
  });

  it('carries the names and the seller id the toolbar filters by', async () => {
    const p = await productIn(KERAMIKA);
    await createDemoReview({ productId: p.id, storeSlug: p.storeSlug, buyerFullName: 'דנה כהן', rating: 4, body: 'יפה' });

    const [row] = (await getAdminReviewsPage(q(), 0, 15)).reviews;

    expect(row!.sellerId).toBe(KERAMIKA_SELLER);
    expect(row!.productName).not.toBe('');
    expect(row!.storeName).not.toBe('');
    expect(row!.productSlug).not.toBe('');
  });

  it('narrows by store, by seller and by state', async () => {
    const keramika = await productIn(KERAMIKA);
    const tachshitim = await productIn(TACHSHITIM);
    await createDemoReview({ productId: keramika.id, storeSlug: keramika.storeSlug, buyerFullName: 'דנה כהן', rating: 5, body: 'אחת' });
    const other = await createDemoReview({ productId: tachshitim.id, storeSlug: tachshitim.storeSlug, buyerFullName: 'רון לוי', rating: 2, body: 'שתיים' });
    await setReviewBlocked(other!.id, true);

    expect((await getAdminReviewsPage(q(`vstore=${keramika.storeSlug}`), 0, 15)).total).toBe(1);
    expect((await getAdminReviewsPage(q(`vseller=${KERAMIKA_SELLER}`), 0, 15)).total).toBe(1);
    expect((await getAdminReviewsPage(q('vstate=hidden'), 0, 15)).reviews.map((r) => r.body)).toEqual(['שתיים']);
    expect((await getAdminReviewsPage(q('vstate=published'), 0, 15)).reviews.map((r) => r.body)).toEqual(['אחת']);
  });

  it('searches the body, the reviewer and the product, ANDing the terms', async () => {
    const p = await productIn(KERAMIKA);
    await createDemoReview({ productId: p.id, storeSlug: p.storeSlug, buyerFullName: 'דנה כהן', rating: 5, body: 'הגיע מהר ושלם' });
    await createDemoReview({ productId: p.id, storeSlug: p.storeSlug, buyerFullName: 'רון לוי', rating: 1, body: 'הגיע שבור' });

    // Stored as `reviewerDisplayName` publishes it — "רון לוי" is shortened on the way in.
    expect((await getAdminReviewsPage(q('vq=שבור'), 0, 15)).reviews.map((r) => r.reviewerName)).toEqual(['רון ל׳']);
    // Both terms must match the same row — one hits the body, the other the reviewer's name.
    expect((await getAdminReviewsPage(q('vq=הגיע רון'), 0, 15)).total).toBe(1);
    expect((await getAdminReviewsPage(q('vq=הגיע'), 0, 15)).total).toBe(2);
  });

  it('reports the total behind the page, and survives a page past the end', async () => {
    const p = await productIn(KERAMIKA);
    for (let i = 0; i < 3; i++) {
      await createDemoReview({ productId: p.id, storeSlug: p.storeSlug, buyerFullName: `קונה ${i}`, rating: 5, body: `ביקורת ${i}` });
    }

    const firstPage = await getAdminReviewsPage(q(), 0, 2);
    expect(firstPage.reviews).toHaveLength(2);
    expect(firstPage.total).toBe(3);

    // The whole reason the count is a `LEFT JOIN … ON true` and not `count(*) OVER ()`: past the
    // end there is no row for a window function to ride on, and the pager would report an empty tab.
    const beyond = await getAdminReviewsPage(q(), 999, 2);
    expect(beyond.reviews).toHaveLength(0);
    expect(beyond.total).toBe(3);
  });

  it('counts hidden reviews in the tab denominator', async () => {
    const p = await productIn(KERAMIKA);
    const review = await createDemoReview({ productId: p.id, storeSlug: p.storeSlug, buyerFullName: 'דנה כהן', rating: 3, body: 'בסדר' });
    await setReviewBlocked(review!.id, true);

    // `countPublishedReviews` deliberately excludes it — that one answers a public question. "3
    // מתוך 412" on an admin screen only means something if 412 is everything there is.
    expect(await countAllReviews()).toBe(1);
  });
});
