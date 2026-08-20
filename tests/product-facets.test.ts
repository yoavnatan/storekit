import { describe, expect, it } from 'vitest';
import {
  FACET_INDEX_MIN_PRODUCTS,
  MAX_FACETS,
  MAX_FACET_TEXT_LENGTH,
  MAX_VALUES_PER_FACET,
  MIN_PRODUCTS_PER_FACET,
  MIN_VALUES_PER_FACET,
  buildFacetParam,
  computeFacets,
  countSelectedFacetValues,
  facetKey,
  isIndexableFacetView,
  parseFacetParam,
  productFacetPairs,
  productMatchesFacets,
  toggleFacetValue,
  type FacetSelection,
} from '../src/lib/product-facets.js';
import { filterAndSortProducts } from '../src/lib/product-listing.js';
import type { StoreProduct } from '../src/lib/store-products.js';

type Spec = { label: string; value: string };

/** A product carrying only what these rules read. */
function p(specs: Spec[]): Pick<StoreProduct, 'specs'> {
  return { specs };
}

/** `?f=` as a selection, for the tests that speak in URLs. */
function sel(param: string): FacetSelection {
  return parseFacetParam(param);
}

describe('facetKey', () => {
  it('folds the differences that carry no meaning', () => {
    expect(facetKey('  גיל  ')).toBe('גיל');
    expect(facetKey('Cotton')).toBe('cotton');
    expect(facetKey('3   -   5')).toBe('3 - 5');
    expect(facetKey('כותנה,')).toBe('כותנה');
  });

  it('treats every dash character as one, which is the drift that broke the panel', () => {
    // A hyphen, an en dash, an em dash and the Hebrew maqaf all reach this from a keyboard, a
    // spreadsheet paste and an autocorrect respectively — and a shopper reads all four as "3 to 5".
    const forms = ['3-5', '3–5', '3—5', '3־5', '3−5'];
    const keys = new Set(forms.map(facetKey));
    expect(keys.size).toBe(1);
  });

  it('does NOT guess that differently-worded values are the same', () => {
    // This is the deliberate limit: convergence happens on the write side (spec-vocabulary.ts),
    // because a read-side rule that merges "3 עד 5" into "3-5" will one day merge two attributes
    // that genuinely differ.
    expect(facetKey('3 עד 5')).not.toBe(facetKey('3-5'));
  });

  it('strips the characters the URL uses as separators, so a key can never need escaping', () => {
    for (const key of [facetKey('גיל: ילדים'), facetKey('א,ב'), facetKey('א~ב'), facetKey('א|ב')]) {
      expect(key).not.toMatch(/[:,~|]/);
    }
  });

  it('keeps an inner dash, which is the range itself', () => {
    expect(facetKey('3-5')).toBe('3-5');
    expect(facetKey('-3-5-')).toBe('3-5');
  });
});

describe('productFacetPairs', () => {
  it('drops a value longer than an attribute can be', () => {
    const long = 'א'.repeat(MAX_FACET_TEXT_LENGTH + 1);
    expect(productFacetPairs(p([{ label: 'הערה', value: long }]))).toEqual([]);
    expect(productFacetPairs(p([{ label: long, value: 'עץ' }]))).toEqual([]);
  });

  it('drops a value that is only punctuation — an emptied spreadsheet cell', () => {
    expect(productFacetPairs(p([{ label: 'חומר', value: '—' }]))).toEqual([]);
    expect(productFacetPairs(p([{ label: 'חומר', value: '' }]))).toEqual([]);
  });

  it('keeps two values under one label but collapses an exact duplicate row', () => {
    const pairs = productFacetPairs(p([
      { label: 'מתאים ל', value: 'בנים' },
      { label: 'מתאים ל', value: 'בנות' },
      { label: 'מתאים ל', value: 'בנים' },
    ]));
    expect(pairs).toHaveLength(2);
    expect(pairs.map((x) => x.valueKey).sort()).toEqual(['בנות', 'בנים']);
  });
});

describe('computeFacets — the bounds that answer "סיבוך יתר"', () => {
  it('offers nothing when an attribute sits on a single product', () => {
    expect(MIN_PRODUCTS_PER_FACET).toBe(2);
    const facets = computeFacets([
      p([{ label: 'חומר', value: 'עץ' }]),
      p([{ label: 'גיל', value: '3-5' }]),
    ]);
    expect(facets).toEqual([]);
  });

  it('offers nothing when every product in view shares the one value', () => {
    expect(MIN_VALUES_PER_FACET).toBe(2);
    const facets = computeFacets([
      p([{ label: 'חומר', value: 'עץ' }]),
      p([{ label: 'חומר', value: 'עץ' }]),
      p([{ label: 'חומר', value: 'עץ' }]),
    ]);
    expect(facets).toEqual([]);
  });

  it('drops a label whose values are free prose rather than an attribute', () => {
    const products = Array.from({ length: MAX_VALUES_PER_FACET + 1 }, (_, i) =>
      p([{ label: 'הערה', value: `הערה מספר ${i}` }]));
    expect(computeFacets(products)).toEqual([]);
  });

  it('shows at most three dimensions, the ones covering the most products', () => {
    expect(MAX_FACETS).toBe(3);
    // Four dimensions; "רביעי" is on the fewest products and must be the one left out.
    const products = [
      p([{ label: 'א', value: '1' }, { label: 'ב', value: '1' }, { label: 'ג', value: '1' }, { label: 'רביעי', value: '1' }]),
      p([{ label: 'א', value: '2' }, { label: 'ב', value: '2' }, { label: 'ג', value: '2' }, { label: 'רביעי', value: '2' }]),
      p([{ label: 'א', value: '1' }, { label: 'ב', value: '2' }, { label: 'ג', value: '1' }]),
    ];
    const facets = computeFacets(products);
    expect(facets).toHaveLength(3);
    expect(facets.map((f) => f.key)).not.toContain('רביעי');
  });

  it('counts a product once toward a label it carries on two rows', () => {
    const facets = computeFacets([
      p([{ label: 'מתאים ל', value: 'בנים' }, { label: 'מתאים ל', value: 'בנות' }]),
      p([{ label: 'מתאים ל', value: 'בנים' }]),
    ]);
    expect(facets[0]!.productCount).toBe(2);
  });

  it('shows the spelling the catalogue mostly uses', () => {
    const facets = computeFacets([
      p([{ label: 'גיל', value: '3-5' }]),
      p([{ label: 'גיל', value: '3–5' }]),
      p([{ label: 'גיל', value: '3-5' }]),
      p([{ label: 'גיל', value: '6-8' }]),
    ]);
    const values = facets[0]!.values;
    expect(values[0]!.value).toBe('3-5');
    // …and all three spellings of it counted as one value, not two chips.
    expect(values[0]!.count).toBe(3);
  });
});

describe('computeFacets — order', () => {
  it('sorts numeric ranges by their number, not alphabetically', () => {
    const facets = computeFacets([
      p([{ label: 'גיל', value: '12+' }]),
      p([{ label: 'גיל', value: '3-5' }]),
      p([{ label: 'גיל', value: '9-12' }]),
      p([{ label: 'גיל', value: '6-8' }]),
    ]);
    expect(facets[0]!.values.map((v) => v.value)).toEqual(['3-5', '6-8', '9-12', '12+']);
  });

  it('sorts clothing sizes by the scale — L between M and XL, never alphabetically', () => {
    const facets = computeFacets([
      p([{ label: 'מידה', value: 'XL' }]),
      p([{ label: 'מידה', value: 'S' }]),
      p([{ label: 'מידה', value: 'L' }]),
      p([{ label: 'מידה', value: 'M' }]),
    ]);
    expect(facets[0]!.values.map((v) => v.value)).toEqual(['S', 'M', 'L', 'XL']);
  });

  it('is deterministic, because SSR, a re-render and the canonical must agree', () => {
    const products = [
      p([{ label: 'חומר', value: 'עץ' }, { label: 'גיל', value: '3-5' }]),
      p([{ label: 'חומר', value: 'בד' }, { label: 'גיל', value: '6-8' }]),
    ];
    expect(JSON.stringify(computeFacets(products))).toBe(JSON.stringify(computeFacets(products)));
  });
});

describe('computeFacets — counts under a live selection', () => {
  const catalogue = [
    p([{ label: 'חומר', value: 'עץ' }, { label: 'גיל', value: '3-5' }]),
    p([{ label: 'חומר', value: 'עץ' }, { label: 'גיל', value: '6-8' }]),
    p([{ label: 'חומר', value: 'בד' }, { label: 'גיל', value: '3-5' }]),
    p([{ label: 'חומר', value: 'בד' }, { label: 'גיל', value: '6-8' }]),
  ];

  it('counts each value against the OTHER dimensions, not against the whole view', () => {
    const facets = computeFacets(catalogue, sel('חומר:עץ'));
    const age = facets.find((f) => f.key === 'גיל')!;
    // Two wooden products, one per age band — not the four the unfiltered view holds.
    expect(age.values.map((v) => [v.value, v.count])).toEqual([['3-5', 1], ['6-8', 1]]);
  });

  it('does NOT let a dimension filter itself, so a second value widens the result', () => {
    const facets = computeFacets(catalogue, sel('גיל:3-5'));
    const age = facets.find((f) => f.key === 'גיל')!;
    // Both bands still offered at their full counts — otherwise picking one age would make every
    // other age unreachable and the filter could only ever be undone.
    expect(age.values.map((v) => [v.value, v.count])).toEqual([['3-5', 2], ['6-8', 2]]);
  });

  it('keeps offering the dimensions it offered before a pick', () => {
    const before = computeFacets(catalogue).map((f) => f.key);
    const after = computeFacets(catalogue, sel('חומר:עץ')).map((f) => f.key);
    expect(after).toEqual(before);
  });

  it('drops a value that would return nothing, but never one that is selected', () => {
    const mixed = [
      ...catalogue,
      p([{ label: 'חומר', value: 'מתכת' }, { label: 'גיל', value: '12+' }]),
      p([{ label: 'חומר', value: 'מתכת' }, { label: 'גיל', value: '12+' }]),
    ];
    const facets = computeFacets(mixed, sel('חומר:עץ'));
    const age = facets.find((f) => f.key === 'גיל')!;
    // No wooden product is 12+, so that chip would return an empty grid — a control that does
    // nothing (memory `feedback_noop_interactions_invisible`).
    expect(age.values.map((v) => v.value)).not.toContain('12+');

    // Selected, it stays — otherwise the shopper could not undo it.
    const stuck = computeFacets(mixed, sel('חומר:עץ,גיל:12+'));
    expect(stuck.find((f) => f.key === 'גיל')!.values.map((v) => v.value)).toContain('12+');
  });
});

describe('productMatchesFacets', () => {
  const wooden35 = p([{ label: 'חומר', value: 'עץ' }, { label: 'גיל', value: '3-5' }]);

  it('is OR inside a dimension and AND across them', () => {
    expect(productMatchesFacets(wooden35, sel('גיל:3-5~6-8'))).toBe(true);
    expect(productMatchesFacets(wooden35, sel('חומר:עץ,גיל:3-5'))).toBe(true);
    expect(productMatchesFacets(wooden35, sel('חומר:בד,גיל:3-5'))).toBe(false);
  });

  it('matches through the same normalisation the panel groups by', () => {
    expect(productMatchesFacets(p([{ label: 'גיל', value: '3–5' }]), sel('גיל:3-5'))).toBe(true);
  });

  it('lets everything through when nothing is selected', () => {
    expect(productMatchesFacets(p([]), new Map())).toBe(true);
  });
});

describe('the ?f= parameter', () => {
  it('round-trips a selection', () => {
    expect(buildFacetParam(sel('גיל:3-5~6-8,חומר:עץ'))).toBe('גיל:3-5~6-8,חומר:עץ');
  });

  it('spells one selection exactly one way, whatever order it was clicked in', () => {
    // Two URLs for one view is how a shelf accumulates ranking under two addresses and the
    // canonical ends up pointing at a page nobody links to.
    expect(buildFacetParam(sel('חומר:עץ,גיל:3-5'))).toBe(buildFacetParam(sel('גיל:3-5,חומר:עץ')));
    expect(buildFacetParam(sel('גיל:6-8~3-5'))).toBe(buildFacetParam(sel('גיל:3-5~6-8')));
  });

  it('degrades to no filter rather than throwing on hand-built rubbish', () => {
    for (const raw of ['', ':::', 'גיל', 'גיל:', ':עץ', ',,,', '~~~']) {
      expect(parseFacetParam(raw).size).toBe(0);
    }
    expect(parseFacetParam(null).size).toBe(0);
    expect(parseFacetParam(undefined).size).toBe(0);
  });

  it('refuses to do more work than a real click can ask for', () => {
    // A crafted URL is the input here, not the panel that produced it.
    const manyGroups = Array.from({ length: 30 }, (_, i) => `ל${i}:ע`).join(',');
    expect(parseFacetParam(manyGroups).size).toBeLessThanOrEqual(MAX_FACETS);

    // Deliberately UNDER the length cap, so this tests the per-dimension cap and not the cap
    // that would have rejected the whole string before reaching it.
    const manyValues = `ג:${Array.from({ length: 60 }, (_, i) => i).join('~')}`;
    expect(manyValues.length).toBeLessThan(300);
    const parsed = parseFacetParam(manyValues);
    expect([...parsed.values()][0]!.size).toBe(MAX_VALUES_PER_FACET);

    // And a string too long to be anything a panel produced is not read at all.
    expect(parseFacetParam('א:'.padEnd(5000, 'ב')).size).toBe(0);
  });
});

describe('toggleFacetValue', () => {
  it('adds, removes, and drops the dimension when its last value goes', () => {
    let s: FacetSelection = new Map();
    s = toggleFacetValue(s, 'גיל', '3-5');
    expect(buildFacetParam(s)).toBe('גיל:3-5');
    s = toggleFacetValue(s, 'גיל', '6-8');
    expect(buildFacetParam(s)).toBe('גיל:3-5~6-8');
    s = toggleFacetValue(s, 'גיל', '3-5');
    expect(buildFacetParam(s)).toBe('גיל:6-8');
    s = toggleFacetValue(s, 'גיל', '6-8');
    expect(s.size).toBe(0);
  });

  it('never mutates the selection it was given', () => {
    const before = sel('גיל:3-5');
    toggleFacetValue(before, 'חומר', 'עץ');
    expect(buildFacetParam(before)).toBe('גיל:3-5');
  });

  it('will not open a fourth dimension', () => {
    let s: FacetSelection = sel('א:1,ב:1,ג:1');
    s = toggleFacetValue(s, 'ד', '1');
    expect(s.size).toBe(MAX_FACETS);
    expect(s.has('ד')).toBe(false);
  });
});

describe('countSelectedFacetValues', () => {
  it('counts values and not dimensions — it is the number on the button', () => {
    expect(countSelectedFacetValues(sel('גיל:3-5~6-8,חומר:עץ'))).toBe(3);
    expect(countSelectedFacetValues(new Map())).toBe(0);
  });
});

describe('isIndexableFacetView — what goes to Google', () => {
  it('indexes one dimension with one value and a real collection behind it', () => {
    expect(isIndexableFacetView(sel('חומר:עץ'), FACET_INDEX_MIN_PRODUCTS)).toBe(true);
  });

  it('refuses a combination — that is the faceted-navigation crawl trap', () => {
    expect(isIndexableFacetView(sel('חומר:עץ,גיל:3-5'), 500)).toBe(false);
    expect(isIndexableFacetView(sel('גיל:3-5~6-8'), 500)).toBe(false);
  });

  it('refuses a thin page, and opens by itself once it stops being one', () => {
    expect(isIndexableFacetView(sel('חומר:עץ'), FACET_INDEX_MIN_PRODUCTS - 1)).toBe(false);
    expect(isIndexableFacetView(sel('חומר:עץ'), FACET_INDEX_MIN_PRODUCTS)).toBe(true);
  });

  it('is never true with nothing selected', () => {
    expect(isIndexableFacetView(new Map(), 500)).toBe(false);
  });
});

describe('filterAndSortProducts honours the selection', () => {
  const base = (over: Partial<StoreProduct>): StoreProduct => ({
    id: over.id ?? '1', storeId: 's', slug: 's', name: over.name ?? 'x', description: '',
    price: over.price ?? 10, stock: 5, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  } as StoreProduct);

  const products = [
    base({ id: '1', name: 'א', specs: [{ label: 'חומר', value: 'עץ' }] }),
    base({ id: '2', name: 'ב', specs: [{ label: 'חומר', value: 'בד' }] }),
    base({ id: '3', name: 'ג', specs: [] }),
  ];

  it('keeps only what matches, and a product with no specs matches no filter', () => {
    const out = filterAndSortProducts(products, { facets: sel('חומר:עץ') });
    expect(out.map((x) => x.id)).toEqual(['1']);
  });

  it('changes nothing when the selection is empty', () => {
    expect(filterAndSortProducts(products, { facets: new Map() })).toHaveLength(3);
    expect(filterAndSortProducts(products, {})).toHaveLength(3);
  });

  it('composes with search rather than replacing it', () => {
    const out = filterAndSortProducts(products, { q: 'א', facets: sel('חומר:עץ') });
    expect(out.map((x) => x.id)).toEqual(['1']);
    expect(filterAndSortProducts(products, { q: 'ב', facets: sel('חומר:עץ') })).toEqual([]);
  });

  it('orders a filtered list the same however the caller reached it', () => {
    /*
     * The store page renders page 1 and `/api/store-products` serves page 2 of the SAME list, so
     * the two must agree on order or the shopper sees a product twice and never sees another. The
     * cheap shape — sort everything once, then `.filter()` the array — gives the same answer today
     * only because `rankDefault`'s tiers are absolute thresholds. This pins the equality itself, so
     * the day a rank becomes relative to the set the disagreement fails here instead of showing up
     * as a duplicate on page 2 that nothing reports.
     */
    const many = Array.from({ length: 40 }, (_, i) => base({
      id: String(i),
      name: `מוצר ${i}`,
      price: (i * 7) % 40,
      createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 20))).toISOString(),
      specs: i % 3 === 0 ? [{ label: 'חומר', value: 'עץ' }] : [{ label: 'חומר', value: 'בד' }],
    }));
    const facets = sel('חומר:עץ');
    for (const sort of ['default', 'name-asc', 'price-asc', 'price-desc', 'newest']) {
      const oneCall = filterAndSortProducts(many, { sort, facets, nowMs: 0 });
      const filterAfterSort = filterAndSortProducts(many, { sort, nowMs: 0 })
        .filter((x) => productMatchesFacets(x, facets));
      expect(oneCall.map((x) => x.id), sort).toEqual(filterAfterSort.map((x) => x.id));
    }
  });
});
