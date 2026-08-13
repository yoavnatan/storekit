import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A wishlist row must never offer a bare "add to cart" for a product that has options.
 *
 * **What was wrong (owner spotted it, 2026-08-12).** `WishlistDrawer` called
 * `addItem(store, name, itemData, 1, undefined, false)` — `undefined` where the chosen combination
 * goes — and then unconditionally set the button's label to "נוסף ✓". For a plain product that is
 * correct. For a garment it produced a cart line with no combination at all, which
 * `variant-combo.ts#resolveSelection` refuses at checkout and `/api/cart/prices` marks `gone`. So
 * the shopper was shown a confirmation for something that would be rejected at the till — the
 * silent-failure class of area-audit row 11, arrived at from the wishlist side.
 *
 * The fix is structural rather than a check inside the handler: the row renders a LINK to the
 * product page instead of an add button, because choosing a size is something only that page can
 * do. This pins the two halves that make it work — the flag being recorded everywhere a product can
 * be hearted, and the drawer branching on it.
 */

const SRC = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

/** Every surface with a heart on it. A fourth one that forgets the flag would silently reintroduce
 *  the bug for whatever it saves, so the list is asserted rather than assumed. */
const WISHLIST_WRITERS = [
  'pages/[storeSlug]/[productSlug].astro',
  'pages/[storeSlug]/index.astro',
  'components/StoreProductModal.astro',
];

describe('wishlist records whether a product has options', () => {
  it('the item type carries the flag', () => {
    expect(read('lib/wishlist.ts')).toMatch(/hasVariants\?: boolean/);
  });

  it.each(WISHLIST_WRITERS)('%s sets hasVariants when it saves', (file) => {
    expect(read(file)).toMatch(/hasVariants:/);
  });

  it('no writer hard-codes it false', () => {
    // `hasVariants: false` would compile, pass the check above, and restore the exact bug.
    for (const f of WISHLIST_WRITERS) expect(read(f)).not.toMatch(/hasVariants:\s*false/);
  });
});

describe('the drawer branches on it', () => {
  const drawer = read('components/WishlistDrawer.astro');

  it('offers a link to the product page instead of an add button', () => {
    expect(drawer).toMatch(/item\.hasVariants \?/);
    expect(drawer).toContain('chooseOptions');
  });

  it('still passes undefined variants on the plain-product path, and only there', () => {
    // The `undefined` argument is correct for a product with no options — this asserts it survives,
    // so a future "fix" does not invent a combination for a product that has none.
    expect(drawer).toMatch(/addItem\([^)]*undefined, false\)/);
    // ...and that the add button is inside the false branch of the hasVariants ternary.
    const addBtnIdx = drawer.indexOf('data-wl-cart=');
    const ternaryIdx = drawer.indexOf('item.hasVariants ?');
    expect(ternaryIdx).toBeGreaterThan(-1);
    expect(addBtnIdx).toBeGreaterThan(ternaryIdx);
  });

  it('the label exists in both locales', () => {
    const t = readFileSync(join(SRC, 'i18n/translations.ts'), 'utf8');
    expect(t.match(/chooseOptions:/g) ?? []).toHaveLength(2);
  });
});
