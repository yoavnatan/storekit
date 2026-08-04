import { describe, it, expect } from 'vitest';
import {
  productSeoHints,
  openProductSeoHints,
  needsSeoAttention,
  MIN_DESCRIPTION_LENGTH,
  MIN_NAME_LENGTH,
  MIN_SPECS,
  type ProductSeoInput,
} from '../src/lib/product-seo-hints.js';

/** A listing with nothing open — every other case is this minus one thing. */
const COMPLETE: ProductSeoInput = {
  name: 'כיסא עץ לפינת אוכל',
  description: 'x'.repeat(MIN_DESCRIPTION_LENGTH),
  imageCount: 1,
  hasCategory: true,
  specCount: MIN_SPECS,
};

const hint = (input: ProductSeoInput, id: string) => productSeoHints(input).find((h) => h.id === id)!;

describe('productSeoHints', () => {
  it('reports nothing open for a complete listing', () => {
    expect(openProductSeoHints(COMPLETE)).toEqual([]);
  });

  it('always returns every hint, satisfied ones included', () => {
    // The editor shows the done ones struck through — a list that shrank as you worked would
    // hide what you already got right.
    expect(productSeoHints(COMPLETE)).toHaveLength(5);
    expect(productSeoHints({ ...COMPLETE, imageCount: 0 })).toHaveLength(5);
  });

  it('treats only the missing image as required — nothing else blocks anything', () => {
    const required = productSeoHints(COMPLETE).filter((h) => h.required).map((h) => h.id);
    expect(required).toEqual(['image']);
  });

  it('opens the image hint with no images, because the ad feed drops such a product outright', () => {
    expect(hint({ ...COMPLETE, imageCount: 0 }, 'image').done).toBe(false);
    expect(hint({ ...COMPLETE, imageCount: 1 }, 'image').done).toBe(true);
  });

  it('measures the description and name on TRIMMED length', () => {
    // Whitespace is not content; a textarea full of newlines must not satisfy the hint.
    const padded = { ...COMPLETE, description: `  ${'x'.repeat(MIN_DESCRIPTION_LENGTH - 1)}  ` };
    expect(hint(padded, 'description').done).toBe(false);
    expect(hint({ ...COMPLETE, name: `   ${'x'.repeat(MIN_NAME_LENGTH - 1)}   ` }, 'name').done).toBe(false);
  });

  it('satisfies each threshold exactly at its boundary, not one past it', () => {
    expect(hint({ ...COMPLETE, description: 'x'.repeat(MIN_DESCRIPTION_LENGTH) }, 'description').done).toBe(true);
    expect(hint({ ...COMPLETE, description: 'x'.repeat(MIN_DESCRIPTION_LENGTH - 1) }, 'description').done).toBe(false);
    expect(hint({ ...COMPLETE, specCount: MIN_SPECS }, 'specs').done).toBe(true);
    expect(hint({ ...COMPLETE, specCount: MIN_SPECS - 1 }, 'specs').done).toBe(false);
    expect(hint({ ...COMPLETE, name: 'x'.repeat(MIN_NAME_LENGTH) }, 'name').done).toBe(true);
  });
});

describe('needsSeoAttention — the products-table marker', () => {
  it('stays off for a listing missing only one or two recommendations', () => {
    // The whole point of the threshold: a catalog sitting at 4-of-5 must not show a marker on
    // every row, or the mark means nothing and gets ignored.
    expect(needsSeoAttention({ ...COMPLETE, specCount: 0 })).toBe(false);
    expect(needsSeoAttention({ ...COMPLETE, specCount: 0, hasCategory: false })).toBe(false);
  });

  it('fires on the required item alone, however complete the rest is', () => {
    expect(needsSeoAttention({ ...COMPLETE, imageCount: 0 })).toBe(true);
  });

  it('fires once three recommendations are open', () => {
    expect(needsSeoAttention({ ...COMPLETE, specCount: 0, hasCategory: false, description: '' })).toBe(true);
  });

  it('fires on a listing that carries only a name and a price', () => {
    expect(needsSeoAttention({ name: 'כיסא', description: '', imageCount: 0, hasCategory: false, specCount: 0 })).toBe(true);
  });
});
