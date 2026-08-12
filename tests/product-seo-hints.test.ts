import { describe, it, expect } from 'vitest';
import {
  productSeoHints,
  openProductSeoHints,
  needsSeoAttention,
  productSeoScore,
  MIN_DESCRIPTION_LENGTH,
  MIN_NAME_LENGTH,
  MIN_SPECS,
  type ProductSeoInput,
} from '../src/lib/product-seo-hints.js';
import { productSeoRowGaugeHtml, productSeoLabels } from '../src/lib/product-seo-field.js';

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

describe('productSeoScore — the editor meter', () => {
  it('counts out of the same list the panel lists', () => {
    expect(productSeoScore(COMPLETE)).toMatchObject({ done: 5, total: 5, percent: 100 });
    expect(productSeoScore({ ...COMPLETE, specCount: 0 })).toMatchObject({ done: 4, total: 5, percent: 80 });
  });

  it('reads `strong` only when nothing at all is open', () => {
    expect(productSeoScore(COMPLETE).level).toBe('strong');
    expect(productSeoScore({ ...COMPLETE, specCount: 0 }).level).toBe('partial');
  });

  it('draws its bands from needsSeoAttention, so the meter and the table marker agree', () => {
    // This is the invariant that matters: two surfaces describing one product must never
    // disagree — a row flagged in the table cannot show a reassuring meter when opened.
    const cases: ProductSeoInput[] = [
      COMPLETE,
      { ...COMPLETE, specCount: 0 },
      { ...COMPLETE, specCount: 0, hasCategory: false },
      { ...COMPLETE, imageCount: 0 },
      { ...COMPLETE, specCount: 0, hasCategory: false, description: '' },
      { name: 'כיסא', description: '', imageCount: 0, hasCategory: false, specCount: 0 },
    ];
    for (const input of cases) {
      expect(productSeoScore(input).level === 'weak').toBe(needsSeoAttention(input));
    }
  });

  it('never calls an image-less listing anything but weak, however complete the rest is', () => {
    // 4 of 5 done, and still amber: the one missing item is the one that keeps it out of the
    // ad feed entirely, so a green-ish meter there would be a lie the seller acts on.
    const noImage = { ...COMPLETE, imageCount: 0 };
    expect(productSeoScore(noImage)).toMatchObject({ done: 4, percent: 80, level: 'weak' });
  });
});

// The products-table row gauge (lib/product-seo-field.ts). It is the same verdict as the panel's
// meter seen from the list, so what is pinned here is that it cannot say something different: it
// appears on exactly the rows needsSeoAttention marks, and its fill is the score.
describe('productSeoRowGaugeHtml — the table column', () => {
  const l = productSeoLabels({});
  const gauge = (input: ProductSeoInput) => productSeoRowGaugeHtml(input, l);

  it('renders on every row, in every band — a column, not an alarm', () => {
    expect(gauge(COMPLETE)).toContain('data-seo-level="strong"');
    expect(gauge({ ...COMPLETE, specCount: 0 })).toContain('data-seo-level="partial"');
    expect(gauge({ ...COMPLETE, imageCount: 0 })).toContain('data-seo-level="weak"');
  });

  it('bands exactly as the filter and the panel meter do', () => {
    for (const input of [COMPLETE, { ...COMPLETE, specCount: 0 }, { ...COMPLETE, imageCount: 0 }]) {
      expect(gauge(input)).toContain(`data-seo-level="${productSeoScore(input).level}"`);
    }
    // The one that reads wrong unless you know the rule: everything but the photo is 4-of-5 and
    // still weak, because an image-less product cannot be advertised at all.
    expect(needsSeoAttention({ ...COMPLETE, imageCount: 0 })).toBe(true);
  });

  it('fills the arc to the score, so 4-of-5-but-no-photo does not read as empty', () => {
    const full = Math.PI * 9;
    const offsetOf = (html: string) => Number(/stroke-dashoffset="([\d.]+)"/.exec(html)![1]);
    expect(offsetOf(gauge({ ...COMPLETE, imageCount: 0 }))).toBeCloseTo(full * 0.2, 2);   // 4 of 5
    expect(offsetOf(gauge(COMPLETE))).toBeCloseTo(0, 2);                                  // 5 of 5
    expect(offsetOf(gauge({ name: '', description: '', imageCount: 0, hasCategory: false, specCount: 0 }))).toBeCloseTo(full, 2);
  });

  it('names itself, the band and what is open — the colour never speaks alone', () => {
    expect(gauge({ ...COMPLETE, imageCount: 0 }))
      .toContain('aria-label="Search visibility · Basic — Missing: Photo (required)"');
    // Nothing open: the band alone, with no dangling "Missing:".
    expect(gauge(COMPLETE)).toContain('aria-label="Search visibility · Excellent"');
  });

  it('pins the svg size inline — reset.css would otherwise flatten or collapse the arc', () => {
    expect(gauge(COMPLETE)).toContain('style="width:21px;height:14px;max-width:none');
  });
});
