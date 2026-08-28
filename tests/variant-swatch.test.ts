import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveVariantColor, variantSwatchBackground } from '../src/lib/color-variants.js';

/**
 * A colour that is not one colour.
 *
 * Every value in `COLOR_MAP` resolves to a single hex, and a value that resolves to nothing gets
 * the dashboard's fallback colour PICKER — which is the right answer for "רק צבע שלא הכרנו" and the
 * wrong one for "צבעוני": the seller had to invent a hex for a product that is deliberately not one
 * colour, and whatever they picked then lied about it on the storefront (owner, 2026-08-28: *"אין
 * לי שם כזה קשת או משהו מיוחד, לצבע מיוחד"*).
 *
 * The two things worth pinning are the two that were easy to get wrong:
 *   · a hex the seller TYPED still wins over the word, so "צבעוני #ffffff" is white and not a
 *     rainbow — somebody who names a shade has said what they want;
 *   · every renderer paints from ONE function, because there are five of them (the storefront, the
 *     quick view, the dashboard chip, the combo label and the combo table) and a rainbow that
 *     appeared in three of them would look like a bug in the other two.
 */

const root = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url));

describe('a multicolour variant', () => {
  it('resolves to no hex and a rainbow background', () => {
    for (const word of ['צבעוני', 'רב-צבעוני', 'רב צבעוני', 'קשת', 'multicolor', 'rainbow', 'MULTI']) {
      const resolved = resolveVariantColor(word);
      expect(resolved.multi, word).toBe(true);
      expect(resolved.hex, word).toBeNull();
      expect(variantSwatchBackground(resolved), word).toMatch(/^conic-gradient\(/);
    }
  });

  it('loses to a hex the seller typed', () => {
    const resolved = resolveVariantColor('צבעוני #ffffff');
    expect(resolved.multi).toBe(false);
    expect(variantSwatchBackground(resolved)).toBe('#ffffff');
  });

  it('leaves ordinary colours and unknown words exactly as they were', () => {
    expect(variantSwatchBackground(resolveVariantColor('אדום'))).toBe('#e53e3e');
    // Unknown → null, which is what makes the dashboard offer its picker and the storefront a
    // plain text chip. Both of those behaviours predate this change and must not move.
    const unknown = resolveVariantColor('חציל מבריק');
    expect(unknown.multi).toBe(false);
    expect(variantSwatchBackground(unknown)).toBeNull();
  });
});

describe('every swatch is painted from one function', () => {
  // The renderers, and the exact hazard: one of them keeping `background:${hex}` would silently
  // draw nothing for a multicolour value while its neighbours drew the rainbow.
  const RENDERERS = [
    'src/pages/[storeSlug]/[productSlug].astro',
    'src/components/ProductQuickView.astro',
    'src/scripts/dashboard/products.ts',
  ];

  it('and none of them paints a raw hex into a swatch', () => {
    const offenders: string[] = [];
    for (const file of RENDERERS) {
      const source = readFileSync(root(file), 'utf8');
      if (!source.includes('variantSwatchBackground')) offenders.push(`${file}: does not use the shared background`);
      for (const [i, line] of source.split('\n').entries()) {
        // A swatch is the element that carries only a background and a size — matching on
        // `background:${hex}` finds it without needing to know each renderer's markup.
        if (/background:\$\{hex\}/.test(line)) offenders.push(`${file}:${i + 1} paints a raw hex`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('the quick view lands on a picked image', () => {
  it('does not smooth-scroll past everything in between', () => {
    /* The product page settled this in August: a smooth scroll across a snap carousel plays every
       slide between here and there, so a colour two photos away made the shopper watch the one
       between flick past. The quick view kept `behavior: 'smooth'` for every distance and was
       reported for exactly that (owner, 2026-08-28). It has no hover overlay to cross-fade with,
       so it takes the product page's own documented fallback: adjacent smooth, further instant. */
    const source = readFileSync(root('src/components/ProductQuickView.astro'), 'utf8');
    const fn = /function scrollToIdx[\s\S]{0,600}?\n\s{8}\}/.exec(source)?.[0] ?? '';
    expect(fn, 'scrollToIdx not found').toContain('scrollTo');
    expect(fn, 'every distance still scrolls smoothly').toMatch(/adjacent/);
    expect(fn).toMatch(/behavior:\s*adjacent\s*\?\s*'smooth'\s*:\s*'auto'/);
  });
});
