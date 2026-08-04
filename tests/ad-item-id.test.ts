/**
 * The id Google and Meta know one item by — `src/lib/ad-item-id.ts`.
 *
 * **The failure this pins is invisible from inside the app.** The Merchant/Catalog feed sent the
 * product uuid as `g:id` while every dataLayer/fbq event sent the slug, and both networks join a
 * catalog item to a browsing event by exactly that id. Nothing looked broken: the feed validated,
 * the events fired, each side was internally consistent — and the two matched on nothing, so
 * dynamic remarketing had no product and "which products did my ads sell" had no answer. There is
 * no screen anywhere that would have shown it.
 *
 * So the test that matters is not "does the helper concatenate correctly" — it is **the feed's row
 * id and the tracked event's id are the same string**, asserted against the real feed builder for
 * both the plain and the variant shape. That is the join, and it is the only thing that can drift.
 */
import { describe, expect, it } from 'vitest';
import { adItemId, adComboItemId } from '../src/lib/ad-item-id.js';
import { buildFeedItems } from '../src/lib/product-feed.js';
import { comboKey } from '../src/lib/variant-combo.js';
import type { StoreProduct } from '../src/lib/store-products.js';

const PRODUCT_ID = '11111111-1111-4111-8111-000000000001';

function product(over: Partial<StoreProduct> = {}): StoreProduct {
  return {
    id: PRODUCT_ID,
    storeId: 'store-1',
    slug: 'אגרטל-כחול',
    name: 'אגרטל כחול',
    description: 'תיאור',
    price: 120,
    stock: 5,
    images: ['https://cdn.example/a.jpg'],
    specs: [],
    variants: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as StoreProduct;
}

const ctx = { storeName: 'קרמיקה', storeSlug: 'keramika', baseUrl: 'https://dezabin.com' };

describe('adItemId', () => {
  it('is the product uuid when no combo is chosen', () => {
    expect(adItemId(PRODUCT_ID)).toBe(PRODUCT_ID);
  });

  it('treats an empty selection as no selection', () => {
    // `{}` is what a caller passes before the shopper has chosen anything. It must not mint a third
    // id shaped like neither the product nor a combo.
    expect(adItemId(PRODUCT_ID, {})).toBe(PRODUCT_ID);
  });

  it('narrows to the chosen combo, keeping Unicode option values distinct', () => {
    const red = adItemId(PRODUCT_ID, { צבע: 'אדום' });
    const blue = adItemId(PRODUCT_ID, { צבע: 'כחול' });
    expect(red).not.toBe(blue);
    expect(red.startsWith(`${PRODUCT_ID}-`)).toBe(true);
  });

  it('does not depend on the order the selection was built in', () => {
    // Two shoppers picking the same combo in a different order are on the same feed row.
    expect(adItemId(PRODUCT_ID, { צבע: 'אדום', מידה: 'L' }))
      .toBe(adItemId(PRODUCT_ID, { מידה: 'L', צבע: 'אדום' }));
  });

  it('agrees with the combo-key spelling the feed uses', () => {
    const selection = { צבע: 'אדום', מידה: 'L' };
    expect(adItemId(PRODUCT_ID, selection)).toBe(adComboItemId(PRODUCT_ID, comboKey(selection)));
  });
});

describe('the feed row id and the tracked event id are ONE id', () => {
  it('plain product: the single feed row carries exactly what an event would send', () => {
    const [row] = buildFeedItems(product(), ctx);
    expect(row!.id).toBe(adItemId(PRODUCT_ID));
  });

  it('variant product: every feed row is reachable from a shopper selection', () => {
    const variants = [
      { name: 'צבע', options: ['אדום', 'כחול'] },
      { name: 'מידה', options: ['S', 'L'] },
    ];
    const rows = buildFeedItems(product({ variants }), ctx);
    expect(rows).toHaveLength(4);

    // A variant product emits NO parent row — only per-combo rows tied by item_group_id. So an
    // event naming the bare product id would match nothing, which is exactly why the helper takes
    // the selection.
    expect(rows.some((r) => r.id === PRODUCT_ID)).toBe(false);
    expect(rows.every((r) => r.itemGroupId === PRODUCT_ID)).toBe(true);

    const fromSelections = [
      { צבע: 'אדום', מידה: 'S' }, { צבע: 'אדום', מידה: 'L' },
      { צבע: 'כחול', מידה: 'S' }, { צבע: 'כחול', מידה: 'L' },
    ].map((sel) => adItemId(PRODUCT_ID, sel));

    expect(rows.map((r) => r.id).sort()).toEqual(fromSelections.sort());
  });

  it('the slug is not the id, and could not be — it is not unique across stores', () => {
    // Migration 0001 measured 47 slugs shared between different stores (which is why
    // wishlist_items keys by product id). Sending a slug reported two unrelated products in two
    // unrelated stores to Google and Meta as the same item.
    const [row] = buildFeedItems(product(), ctx);
    expect(row!.id).not.toBe('אגרטל-כחול');
  });
});
