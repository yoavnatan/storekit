import { describe, it, expect, beforeAll } from 'vitest';
import { setProductFeatured, getStorePreviews, STORE_PREVIEW_SLOTS, createProduct } from '../src/lib/store-products.js';
import { getVisibleStores } from '../src/lib/stores.js';

/**
 * The seller's pick for the homepage store card.
 *
 * Two properties are worth a test and the rest is not. The CAP has to hold under a repeated call,
 * because it is enforced inside the UPDATE's own WHERE clause rather than by a read-then-write —
 * the shape that would look correct in every single-threaded reading and still let two tabs past
 * it. And the FALLBACK has to keep working, because that is the whole reason this feature was safe
 * to ship to every existing store at once: a store that picks nothing must be ordered exactly as it
 * was before, and a store that picks one must still show four thumbnails.
 *
 * Runs against the test database the suite builds (tests/fixtures/db-data), which carries four
 * products in total — so the products this needs are CREATED here rather than found. That is the
 * honest way round: the fixture exists to be small, and a test that quietly skipped itself because
 * the fixture was too thin would report green while checking nothing.
 */
describe('featured products', () => {
  let storeId = '';
  const productIds: string[] = [];

  beforeAll(async () => {
    const [store] = await getVisibleStores();
    storeId = store!.id;
    // One more than the cap, so there is always a product left over to be refused. Each carries an
    // image because `getStorePreviews` ranks only photographed rows — an unphotographed product
    // cannot lead a card even when flagged, which is itself deliberate (see the query's header).
    for (let i = 0; i < STORE_PREVIEW_SLOTS + 2; i++) {
      const p = await createProduct(storeId, {
        name: `featured-fixture-${i}`,
        description: 'x',
        price: 10,
        stock: 5,
        images: [`https://res.cloudinary.com/demo/image/upload/featured-${i}.jpg`],
      });
      productIds.push(p.id);
    }
  });

  it('with nothing chosen, the card is still full', async () => {
    const preview = (await getStorePreviews([storeId], STORE_PREVIEW_SLOTS)).get(storeId);
    expect(preview?.images.length).toBe(STORE_PREVIEW_SLOTS);
  });

  it('a chosen product leads the card, and the rest still fill it', async () => {
    // The OLDEST of the six, which the default `created_at DESC` ordering puts outside the four
    // slots — so seeing it lead proves the flag did it rather than the ordering it already had.
    const outsider = productIds[0]!;
    const before = (await getStorePreviews([storeId], STORE_PREVIEW_SLOTS)).get(storeId)!;

    const res = await setProductFeatured(storeId, outsider, true);
    expect(res.ok).toBe(true);

    const after = (await getStorePreviews([storeId], STORE_PREVIEW_SLOTS)).get(storeId)!;
    expect(after.images.length).toBe(STORE_PREVIEW_SLOTS);
    expect(after.images[0]).not.toBe(before.images[0]);

    await setProductFeatured(storeId, outsider, false);
    const restored = (await getStorePreviews([storeId], STORE_PREVIEW_SLOTS)).get(storeId)!;
    expect(restored.images).toEqual(before.images);
  });

  it('refuses the one past the cap, and says which reason', async () => {
    const picks = productIds.slice(0, STORE_PREVIEW_SLOTS);
    for (const id of picks) expect((await setProductFeatured(storeId, id, true)).ok).toBe(true);

    const overflow = productIds[STORE_PREVIEW_SLOTS]!;
    const refused = await setProductFeatured(storeId, overflow, true);
    expect(refused).toEqual({ ok: false, reason: 'limit', count: STORE_PREVIEW_SLOTS });

    // Unpicking is never capped — a seller has to be able to get out of a state the cap would now
    // refuse to re-enter.
    expect((await setProductFeatured(storeId, picks[0]!, false)).ok).toBe(true);
    expect((await setProductFeatured(storeId, overflow, true)).ok).toBe(true);

    for (const id of productIds) await setProductFeatured(storeId, id, false);
  });

  it('a product id from another store matches nothing', async () => {
    const stores = await getVisibleStores();
    const other = stores.find((s) => s.id !== storeId);
    if (!other) return;
    // An id is not a permission: the WHERE clause pairs product AND store, so a real product id
    // presented with the wrong store is `not-found` rather than a cross-store write.
    const res = await setProductFeatured(other.id, productIds[0]!, true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not-found');
  });
});
