import { describe, expect, it } from 'vitest';
import { productEditRev, storeSettingsRev, mergeByFieldRev, PRODUCT_REV_FIELDS } from '../src/lib/record-rev.js';

// The whole point of a revision is which changes it notices and which it ignores:
// too eager and the seller is asked to confirm saves nobody conflicted with (and
// starts clicking through the real one); too lax and a second tab silently
// overwrites the first. Both directions are asserted here.

const product = {
  name: 'כיסא עץ',
  description: 'כיסא אלון מלא',
  price: 249.9,
  stock: 4,
  images: ['https://res.cloudinary.com/x/a.jpg'],
  categoryId: 'cat-1',
  tags: ['ריהוט', 'עץ'],
  sku: 'CH-1',
  specs: [{ label: 'חומר', value: 'אלון' }],
  discount: { type: 'percent', value: 10, showBadge: true },
  sellerNote: 'להזמין עוד מהספק',
  variants: [{ name: 'צבע', options: ['טבעי', 'שחור'] }],
  variantStock: { 'צבע:טבעי': 2, 'צבע:שחור': 2 },
  variantImages: { 'טבעי': 'https://res.cloudinary.com/x/a.jpg' },
};

describe('productEditRev — the fields the edit form overwrites', () => {
  it('is stable for the same record', () => {
    expect(productEditRev(product)).toBe(productEditRev({ ...product }));
  });

  it('moves when any field the form owns changes', () => {
    const base = productEditRev(product);
    expect(productEditRev({ ...product, price: 250 })).not.toBe(base);
    expect(productEditRev({ ...product, stock: 3 })).not.toBe(base);
    expect(productEditRev({ ...product, name: 'כיסא עץ ' })).not.toBe(base);
    expect(productEditRev({ ...product, tags: ['ריהוט'] })).not.toBe(base);
    expect(productEditRev({ ...product, images: [] })).not.toBe(base);
    expect(productEditRev({ ...product, discount: undefined })).not.toBe(base);
    expect(productEditRev({ ...product, variantStock: { 'צבע:טבעי': 1, 'צבע:שחור': 2 } })).not.toBe(base);
    expect(productEditRev({ ...product, sellerNote: '' })).not.toBe(base);
  });

  it('ignores fields the form never writes — otherwise an unrelated action reads as a conflict', () => {
    const base = productEditRev(product);
    // hide/show, an admin block, a per-combo SKU from a CSV import, view counters
    expect(productEditRev({ ...product, hidden: true } as typeof product)).toBe(base);
    expect(productEditRev({ ...product, blocked: true } as typeof product)).toBe(base);
    expect(productEditRev({ ...product, variantSku: { 'צבע:טבעי': 'X' } } as typeof product)).toBe(base);
    expect(productEditRev({ ...product, slug: 'other', createdAt: 'now' } as typeof product)).toBe(base);
  });

  it('does not depend on object key order — a JSON round-trip must not invent a conflict', () => {
    const reordered = {
      ...product,
      discount: { showBadge: true, value: 10, type: 'percent' },
      variantStock: { 'צבע:שחור': 2, 'צבע:טבעי': 2 },
    };
    expect(productEditRev(reordered)).toBe(productEditRev(product));
  });

  it('tells an absent field apart from an emptied one', () => {
    const { sku: _sku, ...withoutSku } = product;
    expect(productEditRev(withoutSku)).not.toBe(productEditRev({ ...product, sku: '' }));
  });
});

const store = {
  name: 'רהיטי הצפון',
  tagline: 'עבודת יד',
  description: 'נגרייה',
  categories: ['ריהוט'],
  bannerImage: 'https://res.cloudinary.com/x/b.jpg',
  profileImage: '',
  address: 'הרצל 1, חיפה',
  addressVisible: true,
  hours: { sun: { closed: false, open: '09:00', close: '17:00' } },
  hoursVisible: true,
  shipping: { selfPickup: true },
};

describe('storeSettingsRev — the fields the settings form overwrites', () => {
  it('moves when a settings field changes', () => {
    const base = storeSettingsRev(store);
    expect(storeSettingsRev({ ...store, name: 'רהיטי הדרום' })).not.toBe(base);
    expect(storeSettingsRev({ ...store, addressVisible: false })).not.toBe(base);
    expect(storeSettingsRev({ ...store, categories: ['ריהוט', 'עיצוב'] })).not.toBe(base);
    expect(storeSettingsRev({ ...store, shipping: { selfPickup: false } })).not.toBe(base);
    expect(storeSettingsRev({ ...store, hours: { sun: { closed: true, open: '09:00', close: '17:00' } } })).not.toBe(base);
  });

  it('ignores the store sections that save live on their own', () => {
    const base = storeSettingsRev(store);
    // Sale, saved bg colours, feed token, custom domain, slug — each has its own
    // save action outside this form, so none of them may block a settings save.
    expect(storeSettingsRev({ ...store, sale: { headline: 'סוף עונה', percentOff: 20 } } as typeof store)).toBe(base);
    expect(storeSettingsRev({ ...store, bgColors: ['#fff'] } as typeof store)).toBe(base);
    expect(storeSettingsRev({ ...store, feedExportToken: 'abc' } as typeof store)).toBe(base);
    expect(storeSettingsRev({ ...store, slug: 'north-furniture' } as typeof store)).toBe(base);
  });
});

describe('mergeByFieldRev — two tabs, one product', () => {
  // Both tabs loaded this revision; each then edits its own field.
  const baseline = productEditRev(product);
  const merge = (submitted: object, stored: object, force?: boolean) =>
    mergeByFieldRev({ fields: PRODUCT_REV_FIELDS, submitted, stored, baseline, force });

  it('keeps BOTH edits when the two tabs touched different fields', () => {
    // Tab A already saved a new price; tab B is submitting its stock edit on a stale form.
    const stored = { ...product, price: 300 };
    const submitted = { ...product, stock: 9 };
    const { merged, conflicts } = merge(submitted, stored);
    expect(conflicts).toEqual([]);
    expect(merged.stock).toBe(9);    // this tab's edit
    expect(merged.price).toBe(300);  // the other tab's, NOT reverted to 249.9
  });

  it('asks only about the field both tabs set differently, and merges the rest anyway', () => {
    const stored = { ...product, price: 300, sku: 'CH-9' };
    const submitted = { ...product, price: 199, stock: 9 };
    const { merged, conflicts } = merge(submitted, stored);
    expect(conflicts).toEqual(['price']);
    expect(merged.stock).toBe(9);
    expect(merged.sku).toBe('CH-9'); // untouched here → the other tab's value stands
  });

  it('does not ask when both tabs happened to set the SAME value', () => {
    const { conflicts } = merge({ ...product, price: 199 }, { ...product, price: 199 });
    expect(conflicts).toEqual([]);
  });

  it('force settles the disputed field only — everything else still merges', () => {
    const stored = { ...product, price: 300, sku: 'CH-9' };
    const submitted = { ...product, price: 199, stock: 9 };
    const { merged, conflicts } = merge(submitted, stored, true);
    expect(conflicts).toEqual([]);
    expect(merged.price).toBe(199);  // the seller's explicit choice
    expect(merged.sku).toBe('CH-9'); // still not reverted
  });

  it('a client that sends no baseline writes its whole form — how the endpoint behaved before revisions', () => {
    const stored = { ...product, price: 300 };
    const submitted = { ...product, stock: 9 };
    const { merged, conflicts } = mergeByFieldRev({ fields: PRODUCT_REV_FIELDS, submitted, stored, baseline: null });
    expect(conflicts).toEqual([]);
    expect(merged.price).toBe(product.price);
  });

  it('an emptied collection is not confused with an absent one', () => {
    const { sku: _sku, ...storedNoSku } = product;
    // Neither side touched tags; stored has none, the form sends []. Must not read as an edit.
    const stored = { ...storedNoSku, tags: undefined, price: 300 };
    const base = productEditRev(stored);
    const { merged, conflicts } = mergeByFieldRev({
      fields: PRODUCT_REV_FIELDS, submitted: { ...stored, tags: [], stock: 9 }, stored, baseline: base,
    });
    expect(conflicts).toEqual([]);
    expect(merged.stock).toBe(9);
  });
});
