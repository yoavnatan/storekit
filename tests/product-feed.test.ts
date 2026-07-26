import { describe, expect, it } from 'vitest';
import { buildProductFeedAttributes, buildFeedItems, toMerchantXml } from '../src/lib/product-feed.js';
import type { StoreProduct } from '../src/lib/store-products.js';

const CTX = { storeName: 'חנות', storeSlug: 'my-store', baseUrl: 'https://shop.example' };

function product(overrides: Partial<StoreProduct> = {}): StoreProduct {
  return {
    id: 'p1', storeId: 's1', slug: 'x', name: 'מוצר', description: 'תיאור',
    price: 200, stock: 5, createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

describe('buildProductFeedAttributes', () => {
  it('derives gender + age_group from the category path', () => {
    const f = buildProductFeedAttributes(product({ name: 'חולצה' }), { storeName: 'חנות', categoryPath: 'אופנה > גברים' });
    expect(f.gender).toBe('male');
    expect(f.ageGroup).toBe('adult');
  });

  it('maps a baby category to the infant age_group', () => {
    const f = buildProductFeedAttributes(product(), { storeName: 'חנות', categoryPath: 'ביגוד > תינוקות' });
    expect(f.ageGroup).toBe('infant');
  });

  it('defaults brand to the store name and condition to new', () => {
    const f = buildProductFeedAttributes(product(), { storeName: 'סטור ABC' });
    expect(f.brand).toBe('סטור ABC');
    expect(f.condition).toBe('new');
  });

  it('uses the SKU as mpn and reports identifierExists via brand+mpn', () => {
    const withSku = buildProductFeedAttributes(product({ sku: 'ABC-1' }), { storeName: 'חנות' });
    expect(withSku.mpn).toBe('ABC-1');
    expect(withSku.identifierExists).toBe(true);
    const noSku = buildProductFeedAttributes(product({ sku: undefined }), { storeName: 'חנות' });
    expect(noSku.mpn).toBeUndefined();
    expect(noSku.identifierExists).toBe(false);
  });

  it('sets availability from stock', () => {
    expect(buildProductFeedAttributes(product({ stock: 0 }), { storeName: 'x' }).availability).toBe('out_of_stock');
    expect(buildProductFeedAttributes(product({ stock: 3 }), { storeName: 'x' }).availability).toBe('in_stock');
  });

  it('emits the five stable positional custom-label slots', () => {
    // Fixed nowMs so the "new" recency window is deterministic (product is created 2026-01-01).
    const nowMs = Date.parse('2026-06-01T00:00:00.000Z'); // > 30d after creation → not "new"
    const f = buildProductFeedAttributes(product({ price: 40, stock: 2 }), {
      storeName: 'x', storeTags: ['אופנה'], purchasedUnits: 25, nowMs,
    });
    // [price_tier, performance, availability, audience, store_type]
    expect(f.customLabels).toEqual(['budget', 'platform_bestseller', 'low_stock', 'unisex', 'אופנה']);
  });
});

describe('buildFeedItems', () => {
  it('emits one row with an absolute link + image for a plain product', () => {
    const rows = buildFeedItems(product({ slug: 'shirt', images: ['https://cdn/x.jpg', 'https://cdn/y.jpg'] }), CTX);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.link).toBe('https://shop.example/my-store/shirt');
    expect(rows[0]!.imageLink).toBe('https://cdn/x.jpg');
    expect(rows[0]!.additionalImageLinks).toEqual(['https://cdn/y.jpg']);
    expect(rows[0]!.itemGroupId).toBeUndefined();
  });

  it('skips a product with no image or non-positive price', () => {
    expect(buildFeedItems(product({ images: [] }), CTX)).toEqual([]);
    expect(buildFeedItems(product({ images: ['https://cdn/x.jpg'], price: 0 }), CTX)).toEqual([]);
  });

  it('expands variants into item_group_id rows with color/size and per-combo stock', () => {
    const rows = buildFeedItems(product({
      images: ['https://cdn/x.jpg'],
      variants: [{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'M'] }],
      variantStock: { 'מידה=S,צבע=אדום': 0 },
      stock: 7,
    }), CTX);
    expect(rows).toHaveLength(4); // 2 colors × 2 sizes
    for (const r of rows) {
      expect(r.itemGroupId).toBe('p1');
      expect(['אדום', 'כחול']).toContain(r.color);
      expect(['S', 'M']).toContain(r.size);
    }
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(4); // unique ids per combo
    const soldOut = rows.find((r) => r.color === 'אדום' && r.size === 'S');
    expect(soldOut!.availability).toBe('out_of_stock'); // per-combo override
  });
});

describe('toMerchantXml', () => {
  const meta = { title: 'Dezabin', link: 'https://shop.example', description: 'feed', currency: 'ILS' };

  it('produces a Google RSS 2.0 document with the g: namespace and priced items', () => {
    const rows = buildFeedItems(product({ name: 'חולצה', price: 120, images: ['https://cdn/x.jpg'] }), CTX);
    const xml = toMerchantXml(rows, meta);
    expect(xml).toContain('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
    expect(xml).toContain('<g:price>120.00 ILS</g:price>');
    expect(xml).toContain('<g:availability>in_stock</g:availability>');
    expect(xml).toContain('<![CDATA[חולצה]]>');
  });

  it('XML-escapes attribute text and marks identifier_exists=no when there is no id', () => {
    const rows = buildFeedItems(product({ name: 'A & B <x>', sku: undefined, images: ['https://cdn/i.jpg?a=1&b=2'] }), CTX);
    const xml = toMerchantXml(rows, meta);
    expect(xml).toContain('https://cdn/i.jpg?a=1&amp;b=2');
    expect(xml).toContain('<g:identifier_exists>no</g:identifier_exists>');
  });
});
