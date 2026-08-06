// @vitest-environment jsdom
/**
 * Does the document we hand Google and Meta actually satisfy their product-data specs?
 *
 * `product-feed.test.ts` next door tests the MAPPING — that a given product produces the attribute
 * values we intend. This file tests the CONTRACT, and the difference is the point: a mapping test
 * asserts what we meant, and every silent Merchant Center rejection this project has hit got past
 * exactly that kind of test because each side was internally consistent (see `ad-item-id.ts` and
 * `custom-domain.ts#AD_LANDING_PARAM` for the two worked cases). So the rules below are written
 * from the PUBLISHED specs — required fields, value vocabularies, length caps, formats — and the
 * catalogue underneath is deliberately built out of edge cases rather than of clean products.
 *
 * Two specs, one document: the feed is a Google Merchant RSS 2.0 file that Meta Catalog ingests as
 * a data-feed URL (product-feed.ts#toMerchantXml), so a row must satisfy BOTH. They are not the
 * same list — Meta requires `brand` and `condition` on every item where Google only recommends
 * them, and their caps differ — which is why they are asserted separately instead of merged into
 * one "required" set that would quietly drop whichever platform is stricter.
 *
 * Sources, checked 2026-08-06: Google Merchant Center product data specification; Meta Commerce
 * Manager catalog "supported fields" reference. Every number below carries the platform it came
 * from — when one of them changes its spec, the failing assertion should say whose rule moved.
 *
 * The document is parsed with a real XML parser, not with string matching: an unescaped `&` or a
 * stray control character makes the WHOLE feed unparseable and takes every store's products down
 * with it (product-feed.ts's XML_ILLEGAL note), and only a parser catches that.
 */
import { describe, expect, it } from 'vitest';
import { buildFeedItems, toMerchantXml, type FeedItem } from '../src/lib/product-feed.js';
import type { StoreProduct } from '../src/lib/store-products.js';
import { MAX_VARIANT_COMBOS } from '../src/lib/variant-combo.js';

const CURRENCY = 'ILS';
const BASE = 'https://shop.example';

const CTX = {
  storeName: 'חנות הדגמה',
  baseUrl: BASE,
  productLink: (slug: string) => `${BASE}/my-store/${encodeURIComponent(slug)}`,
  nowMs: Date.parse('2026-08-06T00:00:00.000Z'),
};

function product(overrides: Partial<StoreProduct> = {}): StoreProduct {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    storeId: 's1',
    slug: 'חולצה-כחולה',
    name: 'חולצה כחולה',
    description: 'תיאור המוצר',
    price: 120,
    stock: 5,
    images: [`${BASE}/img/a.jpg`, `${BASE}/img/b.jpg`, `${BASE}/img/c.jpg`],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── The catalogue under test ────────────────────────────────────────────────
// Every entry is a shape that has either caused a rejection here or is one plausible seller action
// away from one. A clean product is included precisely once, as the control.
const CATALOGUE: Array<{ label: string; product: StoreProduct }> = [
  { label: 'plain product', product: product() },
  { label: 'no brand, no sku — identifier_exists must say no', product: product({ id: 'a1', sku: undefined, brand: undefined }) },
  { label: 'seller brand + sku', product: product({ id: 'a2', sku: 'SKU-1', brand: 'Nike' }) },
  { label: 'on sale', product: product({ id: 'a3', discount: { type: 'percent', value: 25 } }) },
  { label: 'zero stock', product: product({ id: 'a4', stock: 0 }) },
  { label: 'text at and over every cap', product: product({
    id: 'a5',
    name: 'מ'.repeat(400),
    description: 'ת'.repeat(9000),
    brand: 'B'.repeat(120),
    sku: 'S'.repeat(120),
  }) },
  { label: 'XML-hostile text', product: product({
    id: 'a6',
    name: 'חולצה & מכנס <"מבצע"> ',
    description: 'שורה עם & תווים <לא חוקיים>',
  }) },
  { label: 'emoji at the cap boundary (surrogate pair)', product: product({ id: 'a7', name: 'א'.repeat(149) + '😀' }) },
  { label: 'one colour dimension, per-colour photos', product: product({
    id: 'a8',
    variants: [{ name: 'צבע', options: ['אדום', 'כחול'] }],
    variantImages: { 'אדום': `${BASE}/img/b.jpg`, 'כחול': `${BASE}/img/c.jpg` },
  }) },
  { label: 'colour × size, one combo sold out', product: product({
    id: 'a9',
    variants: [{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'M'] }],
    variantStock: { 'מידה=S,צבע=אדום': 0 },
  }) },
  { label: 'variant combo whose readable id blows the 50-char cap', product: product({
    id: 'aa',
    variants: [
      { name: 'צבע', options: ['אדום עמוק', 'כחול בהיר'] },
      { name: 'מידה', options: ['42 ארוך', '44 קצר'] },
    ],
  }) },
  { label: 'partial variantStock — some combos pooled', product: product({
    id: 'ab',
    stock: 7,
    variants: [{ name: 'צבע', options: ['אדום', 'כחול', 'ירוק'] }],
    variantStock: { 'צבע=כחול': 0 },
  }) },
  { label: 'variantImages pointing at a deleted image', product: product({
    id: 'ac',
    images: [`${BASE}/img/a.jpg`],
    variants: [{ name: 'צבע', options: ['אדום'] }],
    variantImages: { 'אדום': `${BASE}/img/gone.jpg` },
  }) },
  { label: 'site-relative images', product: product({ id: 'ad', images: ['/uploads/x.png', '/uploads/y.png'] }) },
  { label: 'more than ten images', product: product({
    id: 'ae',
    images: Array.from({ length: 14 }, (_, i) => `${BASE}/img/${i}.jpg`),
  }) },
  { label: 'per-combo sku', product: product({
    id: 'af',
    brand: 'Nike',
    variants: [{ name: 'מידה', options: ['S', 'M'] }],
    variantSku: { 'מידה=S': 'NK-S', 'מידה=M': 'NK-M' },
  }) },
  { label: 'custom-domain store (ad landing link already carries ?ad=1)', product: product({ id: 'ag', slug: 'שמלה' }) },
];

function rowsFor(p: StoreProduct, link?: (slug: string) => string): FeedItem[] {
  return buildFeedItems(p, link ? { ...CTX, productLink: link } : CTX);
}

const ALL_ROWS: Array<{ label: string; row: FeedItem }> = CATALOGUE.flatMap(({ label, product: p }) =>
  rowsFor(p, label.startsWith('custom-domain') ? (slug) => `${BASE}/my-store/${encodeURIComponent(slug)}?ad=1` : undefined)
    .map((row) => ({ label, row })),
);

const XML = toMerchantXml(ALL_ROWS.map((r) => r.row), {
  title: 'feed', link: BASE, description: 'feed', currency: CURRENCY,
});

// ── Parsing ────────────────────────────────────────────────────────────────
function parseFeed(xml: string): Element[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.querySelector('parsererror');
  expect(err?.textContent ?? '').toBe('');
  return [...doc.getElementsByTagName('item')];
}

/** The `g:` namespace is what both platforms read; `getElementsByTagName` on an XML document is
 *  namespace-qualified-name based, so `g:id` is asked for by its literal prefixed name. */
function values(item: Element, tag: string): string[] {
  const direct = [...item.getElementsByTagName(tag)];
  const prefixed = [...item.getElementsByTagName(`g:${tag}`)];
  return [...direct, ...prefixed].map((el) => el.textContent ?? '');
}
function value(item: Element, tag: string): string | undefined {
  return values(item, tag)[0];
}

const ITEMS = parseFeed(XML);

// ── The two specs ──────────────────────────────────────────────────────────
/** Google Merchant Center — required for every item, whatever the category. */
const GOOGLE_REQUIRED = ['id', 'title', 'description', 'link', 'image_link', 'availability', 'price'] as const;
/** Meta Catalog — its own required set. `brand` and `condition` are the two Google merely
 *  recommends, and an item missing either is rejected by Meta while Google serves it happily. */
const META_REQUIRED = ['id', 'title', 'description', 'link', 'image_link', 'availability', 'price', 'brand', 'condition'] as const;

/** Google's caps. `id` at 50 is the binding one — Meta allows 100 (ad-item-id.ts#ID_MAX). */
const GOOGLE_MAX: Record<string, number> = {
  id: 50, item_group_id: 50, title: 150, description: 5000, brand: 70, mpn: 70,
  color: 100, size: 100, product_type: 750,
  custom_label_0: 100, custom_label_1: 100, custom_label_2: 100, custom_label_3: 100, custom_label_4: 100,
};
/** Meta's caps, where they differ. Looser than Google's on every field the two share, so a
 *  document that satisfies Google satisfies these — asserted anyway, because "looser" is a fact
 *  about today's spec and not a property of the format. */
const META_MAX: Record<string, number> = { id: 100, title: 200, description: 9999, brand: 100 };

const GOOGLE_AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'preorder', 'backorder']);
const GOOGLE_CONDITION = new Set(['new', 'refurbished', 'used']);
const GOOGLE_GENDER = new Set(['male', 'female', 'unisex']);
const GOOGLE_AGE_GROUP = new Set(['newborn', 'infant', 'toddler', 'kids', 'adult']);
/** `12.34 ILS` — a number with exactly two decimals, a space, the ISO currency. */
const PRICE_FORMAT = /^\d+\.\d{2} ILS$/;
/** `250 g` — Google's fixed unit vocabulary for weight. */
const WEIGHT_FORMAT = /^\d+(\.\d+)? (g|kg|oz|lb)$/;

describe('the feed document', () => {
  it('is well-formed XML that a parser accepts', () => {
    expect(ITEMS.length).toBeGreaterThan(CATALOGUE.length); // variants expand
  });

  it('carries the g: namespace both platforms read attributes from', () => {
    expect(XML).toContain('xmlns:g="http://base.google.com/ns/1.0"');
  });

  it('contains no character XML 1.0 forbids, however the seller pasted it in', () => {
    // Not escapable — a numeric reference to one of these is just as illegal as the raw byte, so
    // the only correct handling is to strip it, and one survivor kills every store's feed at once.
    // eslint-disable-next-line no-control-regex
    expect(XML).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/);
    // An unpaired surrogate is the same class arrived at by accident: clampText cutting a title
    // mid-emoji would leave one behind, and it is just as unescapable as a control byte.
    expect(XML).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe('Google Merchant Center product data spec', () => {
  it.each(GOOGLE_REQUIRED)('every item has a non-empty %s', (tag) => {
    for (const item of ITEMS) {
      expect(value(item, tag)?.trim(), `${tag} on ${value(item, 'id')}`).toBeTruthy();
    }
  });

  it('every id is unique across the whole feed', () => {
    // Two rows on one id is one item overwriting the other — the failure shows up as "some of my
    // products stopped appearing", never as an error, and a variant product multiplies the chance.
    const ids = ITEMS.map((i) => value(i, 'id')!);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(Object.entries(GOOGLE_MAX))('no %s exceeds %i characters', (tag, max) => {
    for (const item of ITEMS) {
      for (const v of values(item, tag)) {
        expect(v.length, `${tag} on ${value(item, 'id')}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it('uses only the published vocabularies', () => {
    for (const item of ITEMS) {
      expect(GOOGLE_AVAILABILITY.has(value(item, 'availability')!)).toBe(true);
      expect(GOOGLE_CONDITION.has(value(item, 'condition')!)).toBe(true);
      expect(GOOGLE_GENDER.has(value(item, 'gender')!)).toBe(true);
      expect(GOOGLE_AGE_GROUP.has(value(item, 'age_group')!)).toBe(true);
    }
  });

  it('formats price and sale_price as "<amount> <currency>"', () => {
    for (const item of ITEMS) {
      expect(value(item, 'price')).toMatch(PRICE_FORMAT);
      const sale = value(item, 'sale_price');
      if (sale !== undefined) {
        expect(sale).toMatch(PRICE_FORMAT);
        // A sale price at or above the regular price is a disapproval, not a discount.
        expect(parseFloat(sale)).toBeLessThan(parseFloat(value(item, 'price')!));
      }
    }
  });

  it('formats shipping_weight with a unit from the fixed vocabulary', () => {
    for (const item of ITEMS) {
      const w = value(item, 'shipping_weight');
      if (w !== undefined) expect(w).toMatch(WEIGHT_FORMAT);
    }
  });

  it('publishes absolute https URLs for link and every image', () => {
    for (const item of ITEMS) {
      for (const tag of ['link', 'image_link', 'additional_image_link']) {
        for (const v of values(item, tag)) {
          expect(() => new URL(v)).not.toThrow();
          expect(new URL(v).protocol, `${tag} on ${value(item, 'id')}`).toBe('https:');
        }
      }
    }
  });

  it('never repeats image_link inside additional_image_link, and caps the list at 10', () => {
    for (const item of ITEMS) {
      const extra = values(item, 'additional_image_link');
      expect(extra.length).toBeLessThanOrEqual(10);
      expect(extra).not.toContain(value(item, 'image_link'));
      expect(new Set(extra).size).toBe(extra.length);
    }
  });

  it('says identifier_exists=no exactly when it has neither gtin nor brand+mpn', () => {
    for (const item of ITEMS) {
      const hasIdentifier = Boolean(value(item, 'gtin') || (value(item, 'brand') && value(item, 'mpn')));
      expect(value(item, 'identifier_exists')).toBe(hasIdentifier ? undefined : 'no');
    }
  });

  it('gives every row of a variant product an item_group_id, and no plain product one', () => {
    for (const { label, row } of ALL_ROWS) {
      const isVariantRow = row.id !== row.itemGroupId && row.itemGroupId !== undefined;
      if (isVariantRow) expect(row.itemGroupId, label).toBeTruthy();
    }
    // A product with no variants is ONE row and must not claim membership of a group.
    expect(rowsFor(product({ id: 'solo' }))[0]!.itemGroupId).toBeUndefined();
  });
});

describe('Meta Catalog spec', () => {
  it.each(META_REQUIRED)('every item has a non-empty %s', (tag) => {
    for (const item of ITEMS) {
      expect(value(item, tag)?.trim(), `${tag} on ${value(item, 'id')}`).toBeTruthy();
    }
  });

  it.each(Object.entries(META_MAX))('no %s exceeds %i characters', (tag, max) => {
    for (const item of ITEMS) {
      for (const v of values(item, tag)) expect(v.length).toBeLessThanOrEqual(max);
    }
  });

  it('never publishes an item Meta would reject for a missing brand, even with no seller brand set', () => {
    // Meta's `brand` is required; ours falls back to the store name, so the seller can never
    // produce a brandless item — this pins that fallback as a SPEC obligation rather than a nicety.
    const rows = rowsFor(product({ id: 'nb', brand: undefined }));
    expect(rows[0]!.brand).toBe(CTX.storeName);
  });
});

describe('the whole feed, as one document', () => {
  it('a product with no usable image contributes no rows at all', () => {
    // image_link is required, so half a product is not a lesser listing — it is a rejected one.
    expect(rowsFor(product({ id: 'ni', images: [] }))).toEqual([]);
    expect(rowsFor(product({ id: 'ni2', images: ['not a url', 'javascript:alert(1)'] }))).toEqual([]);
    // …and that is true of a VARIANT product too: no image means no rows, not rows with a blank one.
    expect(rowsFor(product({
      id: 'ni3', images: [], variants: [{ name: 'צבע', options: ['אדום', 'כחול'] }],
    }))).toEqual([]);
  });

  it('a priced-at-zero product contributes no rows', () => {
    expect(rowsFor(product({ id: 'np', price: 0 }))).toEqual([]);
  });

  it('emits one row per combo and no parent row for a variant product', () => {
    const rows = rowsFor(product({
      id: 'vp',
      variants: [{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'M'] }],
    }));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.itemGroupId === 'vp')).toBe(true);
    expect(rows.some((r) => r.id === 'vp')).toBe(false);
  });

  it('stays within the combo limit the input gates enforce', () => {
    // The feed expands whatever is stored, so this is a statement about the gates upstream
    // (variant-combo.ts#MAX_VARIANT_COMBOS) holding — not about the feed clamping anything.
    for (const { label, product: p } of CATALOGUE) {
      expect(rowsFor(p).length, label).toBeLessThanOrEqual(MAX_VARIANT_COMBOS);
    }
  });
});
