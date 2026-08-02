import { describe, expect, it, vi } from 'vitest';
import { formatScopeNames } from '../src/lib/sale-scope-label.js';
import { salePickedCategoryIds, saleCoversProduct, type StoreSale } from '../src/lib/discounts.js';
import type { StoreCategory } from '../src/lib/store-categories.js';

/** A sale can name several categories. Two lists come out of that and they are NOT the same:
 *  what the seller PICKED (what the banner names) and that expanded downward (what a price is
 *  matched against). These cover the seam between them, plus the wording rule both the banner
 *  and the dashboard picker share. */

// store-sale-scope.ts reads the category tree and the store off disk. Mock the tree so a test
// owns the shape it resolves against; the store/product modules are never reached by the
// functions under test here but must still resolve as modules.
const TREE: StoreCategory[] = [
  { id: 'c-shoes', storeId: 's1', name: 'נעליים', parentId: null, order: 0, createdAt: '2026-07-01' },
  { id: 'c-sport', storeId: 's1', name: 'ספורט', parentId: 'c-shoes', order: 0, createdAt: '2026-07-01' },
  { id: 'c-bags', storeId: 's1', name: 'תיקים', parentId: null, order: 1, createdAt: '2026-07-01' },
  { id: 'c-hats', storeId: 's1', name: 'כובעים', parentId: null, order: 2, createdAt: '2026-07-01' },
  { id: 'c-glasses', storeId: 's1', name: 'משקפיים', parentId: null, order: 3, createdAt: '2026-07-01' },
  { id: 'c-other-store', storeId: 's2', name: 'של מוכר אחר', parentId: null, order: 0, createdAt: '2026-07-01' },
  // Filler, so the cap can be tested against distinct real ids rather than repeats.
  ...Array.from({ length: 12 }, (_, n) => ({ id: `c-x${n}`, storeId: 's1', name: `X${n}`, parentId: null, order: 10 + n, createdAt: '2026-07-01' })),
];

vi.mock('../src/lib/store-categories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/store-categories.js')>();
  return {
    ...actual,
    getCategoriesByStoreId: (storeId: string) => TREE.filter((c) => c.storeId === storeId),
    getCategoryById: (id: string) => TREE.find((c) => c.id === id),
  };
});

const { resolveSaleScope, saleScopeCategoryLabel, MAX_SALE_CATEGORIES } =
  await import('../src/lib/store-sale-scope.js');

describe('resolveSaleScope — several categories in one sale', () => {
  it('unions each pick with everything beneath it', async () => {
    const scope = (await resolveSaleScope('s1', ['c-shoes', 'c-bags']));
    expect(scope?.pickedCategoryIds).toEqual(['c-shoes', 'c-bags']);
    expect(scope?.categoryIds?.sort()).toEqual(['c-bags', 'c-shoes', 'c-sport']);
  });

  it('collapses the overlap when a parent AND its own child are both picked', async () => {
    const scope = (await resolveSaleScope('s1', ['c-shoes', 'c-sport']));
    // Picked stays as the seller chose it; the matched list has each id exactly once, so
    // saleCoversProduct stays a plain membership test.
    expect(scope?.pickedCategoryIds).toEqual(['c-shoes', 'c-sport']);
    expect(scope?.categoryIds).toEqual([...new Set(scope?.categoryIds)]);
  });

  it('keeps `categoryId` on the first pick, so a pre-multi-pick reader still labels something real', async () => {
    expect((await resolveSaleScope('s1', ['c-bags', 'c-hats']))?.categoryId).toBe('c-bags');
  });

  it('drops a category belonging to another seller instead of scoping a sale to it', async () => {
    const scope = (await resolveSaleScope('s1', ['c-bags', 'c-other-store', 'nope']));
    expect(scope?.pickedCategoryIds).toEqual(['c-bags']);
  });

  it('is undefined — a whole-store sale — when no pick survives validation', async () => {
    expect((await resolveSaleScope('s1', ['c-other-store', '', '  ']))).toBeUndefined();
    expect((await resolveSaleScope('s1', []))).toBeUndefined();
  });

  it('ignores a repeated id rather than listing the same category twice', async () => {
    expect((await resolveSaleScope('s1', ['c-bags', 'c-bags']))?.pickedCategoryIds).toEqual(['c-bags']);
  });

  it('caps how many categories one sale can name — enforced here, not in the UI, so a hand-built POST hits it too', async () => {
    const many = Array.from({ length: MAX_SALE_CATEGORIES + 4 }, (_, n) => `c-x${n}`);
    expect((await resolveSaleScope('s1', many))?.pickedCategoryIds).toHaveLength(MAX_SALE_CATEGORIES);
  });
});

describe('salePickedCategoryIds — reading a sale saved before multi-pick', () => {
  it('prefers the picked list', () => {
    const sale: StoreSale = { active: true, title: 'x', categoryId: 'c-shoes', pickedCategoryIds: ['c-shoes', 'c-bags'], categoryIds: ['c-shoes', 'c-sport', 'c-bags'] };
    expect(salePickedCategoryIds(sale)).toEqual(['c-shoes', 'c-bags']);
  });

  it('falls back to the single legacy field, so an old sale needs no migration', () => {
    expect(salePickedCategoryIds({ active: true, title: 'x', categoryId: 'c-shoes', categoryIds: ['c-shoes'] })).toEqual(['c-shoes']);
  });

  it('is empty for a whole-store sale', () => {
    expect(salePickedCategoryIds({ active: true, title: 'x' })).toEqual([]);
    expect(salePickedCategoryIds(undefined)).toEqual([]);
  });
});

describe('the banner wording', () => {
  const AND_MORE = 'ועוד {n}';

  it('names one pick by its full path — which disambiguates two same-named categories', async () => {
    const sale = { active: true, title: 'x', ...(await resolveSaleScope('s1', ['c-sport'])) } as StoreSale;
    expect(saleScopeCategoryLabel(TREE, sale, AND_MORE)).toBe('נעליים › ספורט');
  });

  it('names two picks plainly — paths stacked side by side read as noise', async () => {
    const sale = { active: true, title: 'x', ...(await resolveSaleScope('s1', ['c-sport', 'c-bags'])) } as StoreSale;
    expect(saleScopeCategoryLabel(TREE, sale, AND_MORE)).toBe('ספורט, תיקים');
  });

  it('collapses the tail past two into a count that still admits the sale is wider', async () => {
    const sale = { active: true, title: 'x', ...(await resolveSaleScope('s1', ['c-shoes', 'c-bags', 'c-hats', 'c-glasses'])) } as StoreSale;
    expect(saleScopeCategoryLabel(TREE, sale, AND_MORE)).toBe('נעליים, תיקים ועוד 2');
  });

  it('is empty for a sale that is not category-scoped — the caller has its own wording', () => {
    expect(saleScopeCategoryLabel(TREE, { active: true, title: 'x' }, AND_MORE)).toBe('');
  });

  it('formatScopeNames drops blanks instead of printing a stray separator', () => {
    expect(formatScopeNames(['נעליים', '', '  '], AND_MORE)).toBe('נעליים');
    expect(formatScopeNames([], AND_MORE)).toBe('');
  });
});

describe('what the shopper is actually charged', () => {
  it('covers a product filed under ANY picked branch, and nothing outside them', async () => {
    const sale = { active: true, title: 'x', ...(await resolveSaleScope('s1', ['c-shoes', 'c-bags'])) } as StoreSale;
    expect(saleCoversProduct(sale, { categoryId: 'c-sport' })).toBe(true);  // beneath a pick
    expect(saleCoversProduct(sale, { categoryId: 'c-bags' })).toBe(true);
    expect(saleCoversProduct(sale, { categoryId: 'c-hats' })).toBe(false);
    expect(saleCoversProduct(sale, {})).toBe(false); // no category at all is never swept in
  });
});
