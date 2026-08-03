import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sortCurrentStoreFirst } from '../src/lib/cart-sovereignty.js';

const cart = (storeSlug: string) => ({ storeSlug });

describe('sortCurrentStoreFirst', () => {
  it('moves the current store to the front', () => {
    const carts = [cart('a'), cart('b'), cart('c')];
    expect(sortCurrentStoreFirst(carts, 'c').map((c) => c.storeSlug)).toEqual(['c', 'a', 'b']);
  });

  it('leaves the rest in their original order — it promotes one store, it does not re-sort', () => {
    const carts = [cart('a'), cart('b'), cart('c'), cart('d')];
    expect(sortCurrentStoreFirst(carts, 'b').map((c) => c.storeSlug)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('is a no-op when the current store is not in the cart', () => {
    // The shopper is inside a store they have not added anything from yet. Nothing to promote,
    // and nothing about the other stores should move.
    const carts = [cart('a'), cart('b')];
    expect(sortCurrentStoreFirst(carts, 'zzz').map((c) => c.storeSlug)).toEqual(['a', 'b']);
  });

  it('is a no-op with no current store — a bare /checkout has nothing to be "current"', () => {
    const carts = [cart('a'), cart('b')];
    expect(sortCurrentStoreFirst(carts, null).map((c) => c.storeSlug)).toEqual(['a', 'b']);
    expect(sortCurrentStoreFirst(carts, undefined).map((c) => c.storeSlug)).toEqual(['a', 'b']);
    expect(sortCurrentStoreFirst(carts, '').map((c) => c.storeSlug)).toEqual(['a', 'b']);
  });

  it('never mutates the array it was handed', () => {
    // Both callers render from a list they keep — an in-place sort would reorder the drawer's
    // source of truth as a side effect of drawing it.
    const carts = [cart('a'), cart('b')];
    sortCurrentStoreFirst(carts, 'b');
    expect(carts.map((c) => c.storeSlug)).toEqual(['a', 'b']);
  });

  it('does not lose or duplicate a cart', () => {
    const carts = [cart('a'), cart('b'), cart('c')];
    const sorted = sortCurrentStoreFirst(carts, 'b');
    expect(sorted).toHaveLength(3);
    expect(new Set(sorted.map((c) => c.storeSlug))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('tolerates duplicate slugs without an inconsistent comparator', () => {
    // Cannot happen today (one cart per store), but the previous hand-rolled comparator claimed
    // both a < b and b < a for this input, which is undefined behaviour rather than a no-op.
    const carts = [cart('a'), cart('b'), cart('b')];
    expect(sortCurrentStoreFirst(carts, 'b').map((c) => c.storeSlug)).toEqual(['b', 'b', 'a']);
  });
});

describe('the sovereignty rule is not hand-rolled anywhere', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  }

  it('every file that sorts carts by a current-store slug goes through the shared helper', () => {
    // The drawer and the checkout page each grew their own version of "float this store to the
    // top". They are the same rule and they have to stay identical, so a file that compares a
    // store slug inside a sort comparator must be using cart-sovereignty.ts to do it.
    const offenders = [...walk('src/components'), ...walk('src/pages'), ...walk('src/lib')]
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => !f.endsWith('cart-sovereignty.ts'))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        const sortsOnCurrentStore = /\.sort\(\([^)]*\)\s*=>[\s\S]{0,200}?storeSlug\s*===\s*current/.test(src);
        return sortsOnCurrentStore && !src.includes('sortCurrentStoreFirst');
      });
    expect(offenders).toEqual([]);
  });
});

describe('every "to checkout" entry point names the store it was pressed in', () => {
  // The bug this closes: the add-to-cart toast linked to /checkout?store=…, while the product
  // modal and the product page linked to a bare /checkout. Same button, same words, two different
  // resulting pages. `?store=` is now intent (pre-tick that store) rather than a filter, so every
  // in-store entry point must carry it — a bare /checkout is reserved for the cart-wide buttons,
  // which genuinely mean "all of it".
  const files = [
    'src/components/AddToCartPreview.astro',
    'src/components/StoreProductModal.astro',
    'src/components/ProductQuickView.astro',
    'src/pages/[storeSlug]/[productSlug].astro',
  ];

  for (const file of files) {
    it(`${file} passes ?store= on its checkout link`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).toMatch(/\/checkout\?store=/);
      // No bare /checkout left behind in a quoted href or a navigation on these pages.
      expect(src).not.toMatch(/["'`]\/checkout["'`]/);
    });
  }
});
