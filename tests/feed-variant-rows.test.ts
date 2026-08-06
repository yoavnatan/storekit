/**
 * What a VARIANT product's feed rows say — the half of the feed that has no parent row to fall
 * back on, and therefore the half where a per-row mistake removes the product from the catalogue
 * rather than degrading it.
 *
 * Every case here is a bug that was live until 2026-08-06. They share one shape: `buildFeedItems`
 * derived the product's attributes ONCE and spread them onto every combo, which is right for the
 * things that describe the product and wrong for everything that describes the combination. Nothing
 * was detectably broken — the feed validated, every row resolved, each field was internally
 * consistent — which is why the whole class survived.
 */
import { describe, expect, it } from 'vitest';
import { buildFeedItems } from '../src/lib/product-feed.js';
import { AVAILABILITY_SLOT } from '../src/lib/product-labels.js';
import { parseVariantLanding, variantLandingUrl, VARIANT_PARAM } from '../src/lib/variant-landing.js';
import type { StoreProduct } from '../src/lib/store-products.js';

const BASE = 'https://shop.example';
const CTX = {
  storeName: 'חנות',
  baseUrl: BASE,
  productLink: (slug: string) => `${BASE}/my-store/${encodeURIComponent(slug)}`,
  nowMs: Date.parse('2026-08-06T00:00:00.000Z'),
};

const IMG = { a: `${BASE}/img/a.jpg`, b: `${BASE}/img/b.jpg`, c: `${BASE}/img/c.jpg` };

function product(overrides: Partial<StoreProduct> = {}): StoreProduct {
  return {
    id: 'p1', storeId: 's1', slug: 'חולצה', name: 'חולצה', description: 'תיאור',
    price: 100, stock: 10, images: [IMG.a, IMG.b, IMG.c],
    createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

const COLOUR_SIZE: Partial<StoreProduct> = {
  variants: [{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'M'] }],
};

function rowByColour(rows: ReturnType<typeof buildFeedItems>, colour: string) {
  return rows.filter((r) => r.color === colour);
}

describe('a combo row carries its own photo', () => {
  it("uses the colour's linked image, not the gallery's first", () => {
    // A row declaring `color: אדום` used to ship images[0] — the blue photo — which for a colour
    // variant is the one mismatch a reviewer checks a variant row FOR, and a wrong-product ad even
    // when it is not disapproved.
    const rows = buildFeedItems(product({
      ...COLOUR_SIZE,
      variantImages: { 'אדום': IMG.b, 'כחול': IMG.c },
    }), CTX);
    expect(rowByColour(rows, 'אדום').every((r) => r.imageLink === IMG.b)).toBe(true);
    expect(rowByColour(rows, 'כחול').every((r) => r.imageLink === IMG.c)).toBe(true);
  });

  it('gives every size of one colour the same photo — a colour implies the picture, a size does not', () => {
    const rows = buildFeedItems(product({ ...COLOUR_SIZE, variantImages: { 'אדום': IMG.b } }), CTX);
    const reds = rowByColour(rows, 'אדום');
    expect(reds).toHaveLength(2);
    expect(new Set(reds.map((r) => r.imageLink)).size).toBe(1);
  });

  it("falls back to the gallery's first image when the colour has no linked photo", () => {
    const rows = buildFeedItems(product({ ...COLOUR_SIZE, variantImages: { 'אדום': IMG.b } }), CTX);
    expect(rowByColour(rows, 'כחול').every((r) => r.imageLink === IMG.a)).toBe(true);
  });

  it('ignores a link to an image the product no longer has', () => {
    // The form only lets a seller link a photo the product already carries — but deleting that
    // photo afterwards leaves the link behind, and publishing a URL the landing page does not show
    // is a mismatch. Absent beats stale.
    const rows = buildFeedItems(product({
      images: [IMG.a],
      variants: [{ name: 'צבע', options: ['אדום'] }],
      variantImages: { 'אדום': `${BASE}/img/deleted.jpg` },
    }), CTX);
    expect(rows[0]!.imageLink).toBe(IMG.a);
  });

  it('resolves a site-relative linked photo against the feed origin', () => {
    const rows = buildFeedItems(product({
      images: ['/uploads/a.png', '/uploads/b.png'],
      variants: [{ name: 'צבע', options: ['אדום'] }],
      variantImages: { 'אדום': '/uploads/b.png' },
    }), CTX);
    expect(rows[0]!.imageLink).toBe(`${BASE}/uploads/b.png`);
  });

  it("never repeats the row's own photo in its additional images", () => {
    const rows = buildFeedItems(product({ ...COLOUR_SIZE, variantImages: { 'אדום': IMG.b } }), CTX);
    for (const row of rows) expect(row.additionalImageLinks).not.toContain(row.imageLink);
  });
});

describe('a combo row lands on its own combination', () => {
  it('appends the combo to the link so an ad click arrives on what it advertised', () => {
    const rows = buildFeedItems(product({ ...COLOUR_SIZE }), CTX);
    for (const row of rows) {
      const url = new URL(row.link);
      const landed = parseVariantLanding(url, COLOUR_SIZE.variants);
      expect(landed).toEqual({ 'צבע': row.color, 'מידה': row.size });
    }
  });

  it('gives each combo a DISTINCT landing, so no two rows point at one page state', () => {
    const rows = buildFeedItems(product({ ...COLOUR_SIZE }), CTX);
    expect(new Set(rows.map((r) => r.link)).size).toBe(rows.length);
  });

  it('rides alongside the ad-landing marker instead of replacing it', () => {
    // A store on a verified custom domain publishes `?ad=1` so its platform URL does not 301 off
    // the only domain the Merchant account can claim (custom-domain.ts#AD_LANDING_PARAM). Losing
    // that marker to the variant parameter would reintroduce the cross-domain redirect.
    const rows = buildFeedItems(product({ ...COLOUR_SIZE }), {
      ...CTX,
      productLink: (slug) => `${BASE}/my-store/${encodeURIComponent(slug)}?ad=1`,
    });
    for (const row of rows) {
      const url = new URL(row.link);
      expect(url.searchParams.get('ad')).toBe('1');
      expect(url.searchParams.get(VARIANT_PARAM)).toBeTruthy();
    }
  });

  it('leaves a plain product’s link untouched', () => {
    const rows = buildFeedItems(product(), CTX);
    expect(rows[0]!.link).toBe(`${BASE}/my-store/${encodeURIComponent('חולצה')}`);
  });
});

describe('a combo row reports its own availability — in the attribute AND in the label', () => {
  it('marks only the sold-out combination out_of_stock', () => {
    const rows = buildFeedItems(product({
      ...COLOUR_SIZE,
      variantStock: { 'מידה=S,צבע=אדום': 0 },
    }), CTX);
    const sold = rows.find((r) => r.color === 'אדום' && r.size === 'S')!;
    expect(sold.availability).toBe('out_of_stock');
    expect(rows.filter((r) => r.availability === 'in_stock')).toHaveLength(3);
  });

  it('keeps custom_label_2 in step with the availability attribute on every row', () => {
    // These two used to disagree: the attribute came from the combo's bucket and the label from
    // the product's shared pool, so a campaign filtering on `custom_label_2 = out_of_stock` bid on
    // rows Google was serving as in_stock, and skipped rows that really had sold out.
    const rows = buildFeedItems(product({
      ...COLOUR_SIZE,
      stock: 50,
      variantStock: { 'מידה=S,צבע=אדום': 0, 'מידה=M,צבע=אדום': 2 },
    }), CTX);
    const label = (colour: string, size: string) =>
      rows.find((r) => r.color === colour && r.size === size)!.customLabels[AVAILABILITY_SLOT];
    expect(label('אדום', 'S')).toBe('out_of_stock');
    expect(label('אדום', 'M')).toBe('low_stock');
    expect(label('כחול', 'S')).toBe('in_stock');
  });

  it('leaves the four product-scope labels identical across every row', () => {
    // Price tier, performance, audience and store type describe the PRODUCT — a combo that
    // disagreed with its siblings on those would fragment the group a campaign targets.
    const rows = buildFeedItems(product({ ...COLOUR_SIZE }), CTX);
    const productScope = (r: (typeof rows)[number]) => r.customLabels.filter((_, i) => i !== AVAILABILITY_SLOT);
    for (const row of rows) expect(productScope(row)).toEqual(productScope(rows[0]!));
  });

  it('falls back to the shared pool for a combo the seller never counted', () => {
    const rows = buildFeedItems(product({
      stock: 0,
      variants: [{ name: 'צבע', options: ['אדום', 'כחול'] }],
      variantStock: { 'צבע=אדום': 4 },
    }), CTX);
    expect(rows.find((r) => r.color === 'אדום')!.availability).toBe('in_stock');
    expect(rows.find((r) => r.color === 'כחול')!.availability).toBe('out_of_stock');
  });
});

describe('parseVariantLanding — the value arrives from a URL, so it is untrusted', () => {
  const variants = COLOUR_SIZE.variants!;
  const url = (v: string) => new URL(`${BASE}/p?${VARIANT_PARAM}=${encodeURIComponent(v)}`);

  it('reads back exactly what variantLandingUrl wrote', () => {
    const link = variantLandingUrl(`${BASE}/p`, { 'צבע': 'אדום', 'מידה': 'M' });
    expect(parseVariantLanding(new URL(link), variants)).toEqual({ 'צבע': 'אדום', 'מידה': 'M' });
  });

  it('drops a dimension the product does not have', () => {
    expect(parseVariantLanding(url('חומר=כותנה,צבע=אדום'), variants)).toEqual({ 'צבע': 'אדום' });
  });

  it('drops an option the dimension does not offer', () => {
    expect(parseVariantLanding(url('צבע=סגול'), variants)).toEqual({});
  });

  it('keeps the first of a repeated dimension, so a page never shows two answers for one rubric', () => {
    expect(parseVariantLanding(url('צבע=אדום,צבע=כחול'), variants)).toEqual({ 'צבע': 'אדום' });
  });

  it('ignores an oversized value instead of parsing it', () => {
    expect(parseVariantLanding(url('צבע=אדום,'.repeat(200)), variants)).toEqual({});
  });

  it('treats a product with no variants as nothing to select', () => {
    expect(parseVariantLanding(url('צבע=אדום'), undefined)).toEqual({});
    expect(parseVariantLanding(url('צבע=אדום'), [])).toEqual({});
  });

  it('returns {} for junk rather than throwing or half-selecting', () => {
    for (const junk of ['', '=', '===', 'צבע', ',,,', '=אדום', '{}', '%%%']) {
      expect(() => parseVariantLanding(url(junk), variants)).not.toThrow();
      expect(parseVariantLanding(url(junk), variants)).toEqual({});
    }
  });

  it('splits on the FIRST separator, so an option value may contain one', () => {
    const withEq = [{ name: 'מידה', options: ['40=41'] }];
    expect(parseVariantLanding(url('מידה=40=41'), withEq)).toEqual({ 'מידה': '40=41' });
  });

  it('is absent-parameter safe', () => {
    expect(parseVariantLanding(new URL(`${BASE}/p`), variants)).toEqual({});
  });
});
