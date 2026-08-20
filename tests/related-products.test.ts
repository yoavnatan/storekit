import { describe, it, expect } from 'vitest';
import { buildRelatedGroups } from '../src/lib/related-products.js';
import type { StoreCategory } from '../src/lib/store-categories.js';
import type { StoreProduct } from '../src/lib/store-products.js';

// Minimal fixtures — only the fields the ranking reads. The cast is safe for the same reason
// product-listing.test.ts's is: nothing else in the row is touched.
function prod(id: string, over: Partial<StoreProduct> = {}): StoreProduct {
  return { id, slug: id, name: id, price: 100, stock: 5, storeId: 's1', ...over } as StoreProduct;
}
function cat(id: string, parentId: string | null = null): StoreCategory {
  return { id, storeId: 's1', parentId, name: id } as StoreCategory;
}

const ids = (ps: StoreProduct[]) => ps.map((p) => p.id);

// kitchen ─ pots
//         └ knives
// garden
const CATS = [cat('kitchen'), cat('pots', 'kitchen'), cat('knives', 'kitchen'), cat('garden')];

describe('related products — which shelf, then which price', () => {
  it('leads with the product\'s OWN shelf as a named group, and puts the rest of the shop behind it', () => {
    const current = prod('current', { categoryId: 'pots', price: 100 });
    const others = [
      prod('garden-hose', { categoryId: 'garden' }),
      prod('pot-a', { categoryId: 'pots' }),
      prod('pot-b', { categoryId: 'pots' }),
      prod('pot-c', { categoryId: 'pots' }),
      prod('knife', { categoryId: 'knives' }),
    ];
    const [first, second] = buildRelatedGroups(current, others, CATS);
    expect(first?.kind).toBe('category');
    expect(first?.categoryName).toBe('pots');
    expect(ids(first!.products).sort()).toEqual(['pot-a', 'pot-b', 'pot-c']);
    // A sibling shelf under the same parent is the nearest thing to "goes with", so it leads
    // the second row ahead of an unrelated department.
    expect(ids(second!.products)).toEqual(['knife', 'garden-hose']);
  });

  it('counts a SUBCATEGORY of the shelf as the same shelf — the heading must not promise more than the row shows', () => {
    const current = prod('current', { categoryId: 'kitchen' });
    const others = [
      prod('pot', { categoryId: 'pots' }),
      prod('pan', { categoryId: 'pots' }),
      prod('knife', { categoryId: 'knives' }),
      prod('spade', { categoryId: 'garden' }),
    ];
    const [first] = buildRelatedGroups(current, others, CATS);
    expect(first?.kind).toBe('category');
    expect(first?.categoryName).toBe('kitchen');
    expect(ids(first!.products).sort()).toEqual(['knife', 'pan', 'pot']);
  });

  it('ranks by price RATIO, so a cheap product is not "related" to every other cheap product', () => {
    const current = prod('current', { categoryId: 'pots', price: 80 });
    const others = [
      prod('far', { categoryId: 'pots', price: 900 }),
      prod('near', { categoryId: 'pots', price: 95 }),
      prod('mid', { categoryId: 'pots', price: 200 }),
    ];
    const [first] = buildRelatedGroups(current, others, CATS);
    expect(ids(first!.products)).toEqual(['near', 'mid', 'far']);
  });

  it('sinks a sold-out product below an in-stock one however close its price is', () => {
    const current = prod('current', { categoryId: 'pots', price: 100 });
    const others = [
      prod('exact-but-gone', { categoryId: 'pots', price: 100, stock: 0 }),
      prod('pricier-but-here', { categoryId: 'pots', price: 260 }),
      prod('also-here', { categoryId: 'pots', price: 300 }),
    ];
    const [first] = buildRelatedGroups(current, others, CATS);
    expect(ids(first!.products)).toEqual(['pricier-but-here', 'also-here', 'exact-but-gone']);
  });

  it('does not label a group of two — one honest row beats a heading over an almost-empty shelf', () => {
    const current = prod('current', { categoryId: 'pots' });
    const others = [prod('pot-a', { categoryId: 'pots' }), prod('pot-b', { categoryId: 'pots' }), prod('spade', { categoryId: 'garden' })];
    const groups = buildRelatedGroups(current, others, CATS);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('store');
    // Merged, not dropped: the two same-shelf products still lead the row.
    expect(ids(groups[0]!.products)).toEqual(['pot-a', 'pot-b', 'spade']);
  });

  it('falls back to one plain row when the product has no category, or points at a deleted one', () => {
    const others = [prod('a'), prod('b', { categoryId: 'pots' })];
    for (const current of [prod('current'), prod('current', { categoryId: 'gone' })]) {
      const groups = buildRelatedGroups(current, others, CATS);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.kind).toBe('store');
      expect(groups[0]!.products).toHaveLength(2);
    }
  });

  it('never exceeds the per-group cap, and spills the overflow of a big shelf into the second row', () => {
    const current = prod('current', { categoryId: 'pots', price: 100 });
    const others = Array.from({ length: 11 }, (_, i) => prod(`pot-${i}`, { categoryId: 'pots', price: 100 + i }));
    const groups = buildRelatedGroups(current, others, CATS, 4);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.products).toHaveLength(4);
    expect(groups[1]!.products).toHaveLength(4);
    // No product may appear in both rows.
    const seen = [...ids(groups[0]!.products), ...ids(groups[1]!.products)];
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('returns nothing at all for a shop with a single product', () => {
    expect(buildRelatedGroups(prod('current', { categoryId: 'pots' }), [], CATS)).toEqual([]);
  });

  it('sorts a product with no price last — it is incomparable, not a match for everything', () => {
    const current = prod('current', { categoryId: 'pots', price: 100 });
    const others = [
      prod('priceless', { categoryId: 'pots', price: 0 }),
      prod('near', { categoryId: 'pots', price: 110 }),
      prod('far', { categoryId: 'pots', price: 900 }),
    ];
    const [first] = buildRelatedGroups(current, others, CATS);
    expect(ids(first!.products)).toEqual(['near', 'far', 'priceless']);
  });

  it('holds a stable order — never a NaN out of the comparator — when EVERY distance ties', () => {
    // A priceless product being looked at: nothing can be nearer to it than anything else, so the
    // caller's own order (newest first) has to survive intact rather than the sort going undefined.
    const current = prod('current', { categoryId: 'pots', price: 0 });
    const others = ['a', 'b', 'c', 'd'].map((id) => prod(id, { categoryId: 'pots', price: 0 }));
    const [first] = buildRelatedGroups(current, others, CATS);
    expect(ids(first!.products)).toEqual(['a', 'b', 'c', 'd']);
  });
});
