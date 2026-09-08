import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sortCurrentStoreFirst } from '../src/lib/cart-sovereignty.js';
import { readSource, sourceGuard } from './helpers/source-guard.js';

/** Every file under a directory, recursively — the sweep both guards below share. */
function walkAll(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walkAll(full) : [full];
  });
}

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

describe('one shop at a time — the drawer, and the button that is not there', () => {
  /* ── Owner, סשן א׳, 2026-09-08 ──
     *"שאין חוויה של ״תשלום 1 מתוך 3״ אלא של זרימה בין חנות לחנות"*, and, on the fork:
     the drawer holds only the shop the shopper is inside.

     Both halves are guarded because both are the kind of thing a later session restores by
     accident: filtering to one shop looks like a bug from the outside ("why is my cart missing
     things"), and a grand total is the obvious thing to add back to a drawer that lists several
     shops off a storefront. What makes them right is a fact that is not visible in the drawer at
     all — each shop clears into its OWN account (`docs/pivot-saas.md`), so one payment cannot span
     two of them, and a button offering to is a queue wearing a total. */

  it('the drawer renders the current shop alone, and the others as a signpost', () => {
    expect(
      sourceGuard({
        file: 'src/components/CartDrawer.astro',
        rule: 'inside a shop the drawer filters the carts to that shop',
        find: (src) => (
          src.includes('insideStore ? allCarts.filter((c) => c.storeSlug === currentSlug) : allCarts')
            ? [] : ['the drawer no longer filters to the current shop']
        ),
        mustReject: 'const carts = sortCurrentStoreFirst(getActiveStoreCarts(), currentSlug);',
      }),
    ).toEqual([]);
    // And the rest are still NAMED — the half that stops the filter from reading as loss.
    const src = readFileSync(join('src', 'components', 'CartDrawer.astro'), 'utf8');
    expect(src).toContain('cart-elsewhere');
    expect(src).toContain('elsewhereTitle');
  });

  it('an empty shop does not claim the whole cart is empty', () => {
    /* The state this exists for, and the one that reads worst if it is wrong: the shopper walks
       into a shop he has not bought from while holding two other carts. "העגלה ריקה" over a list
       of two shops with items in them is the drawer contradicting itself on one screen — which is
       what it did until it was opened and looked at. */
    expect(
      sourceGuard({
        file: 'src/components/CartDrawer.astro',
        rule: 'the empty line asks whether the OTHER carts are empty too',
        find: (src) => (src.includes('elsewhere.length') && src.includes('emptyHere') ? [] : ['the empty line is unconditional']),
        mustReject: "lines.innerHTML = `<p class=\"cart-empty\">${i18n.empty}</p>${elsewhereHtml}`;",
      }),
    ).toEqual([]);
  });

  it('nothing anywhere offers to pay every shop at once', () => {
    // The three names that shipped this: the button (`payAll`), the tooltip explaining it
    // (`payInfo`), and the summed figure it sat under (`getGrandTotal` / `.cart-grand-total`).
    for (const dead of ['payAll', 'payInfo', 'getGrandTotal', 'cart-grand-total']) {
      const offenders = [...walkAll('src'), ...walkAll('tests')]
        .filter((f) => /\.(ts|astro|css)$/.test(f))
        .filter((f) => !f.endsWith('cart-sovereignty.test.ts'))
        // `readSource`, never a raw read: the note in `translations.ts` explaining WHY these
        // strings went names all three of them, and a guard satisfied — or here, broken — by its
        // own documentation is the first trap `helpers/source-guard.ts` was written against. It
        // caught this on the first run.
        .filter((f) => readSource(f).includes(dead));
      expect(offenders, `"${dead}" is back`).toEqual([]);
    }
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
