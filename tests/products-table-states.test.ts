import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE PRODUCTS TABLE HAS THREE STATES AND NOTHING ELSE MOVES.
 *
 * Owner, 2026-08-23, after recording his own screen while resizing: *"יש עדיין קפיצות מאוד מוזרות
 * בריווחים מלא פעמים"*, then the specification this file exists to hold:
 *
 *     *"יש שם פעם אחת של היעלמות של המספר הסידורי, אחר כך היעלמות של המק״ט, ואח״כ מעבר
 *      לכרטיסייה. זהו. רק לוודא שתמיד הכותרות נראות לעין לפחות ברובן."*
 *
 * Three transitions, and between them everything shrinks continuously. Measured on the running
 * dashboard, dragging 1440 → 700 in 5px steps: **52 abrupt steps before, 5 after** — and those 5
 * are the transitions themselves, which he explicitly said are fine.
 *
 * WHAT CAUSED THE 52, because the shape recurs. Two hand-tuned sets of column percentages swapped
 * at a breakpoint, a third nested inside one of them, and three padding regimes switching
 * independently — all keyed to the TABLE's width through a container query. The table's width is
 * not monotonic in the window's, because the side rail hands its column back when it collapses. So
 * the sets swapped, swapped back thirty pixels later, and swapped again.
 *
 * This test guards the SHAPE rather than the numbers: one width set, one padding declaration, and
 * no container query deciding what the seller can see. Re-tune the values freely; re-introduce a
 * second set and this fails.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const css = read('src/styles/pages/dashboard.css');

/** The columns whose width is a share of the table, i.e. the ones that must shrink smoothly. */
const FLUID = ['name-col', 'sku-col', 'cat-col', 'price-col', 'stock-col',
               'wishlist-col', 'purchased-col', 'date-col'];

describe('the products table has three states', () => {
  it('declares each fluid column exactly once, so no second set can swap in', () => {
    for (const col of FLUID) {
      const declarations = [...css.matchAll(new RegExp(`\\.products-table \\.${col}\\s*\\{[^}]*width:`, 'g'))];
      expect(
        declarations.length,
        `${col} is declared ${declarations.length} times — two width sets swapping at a breakpoint ` +
          'is exactly what produced 52 abrupt steps across one resize',
      ).toBe(1);
    }
  });

  it('sizes the cells with ONE continuous rule rather than a padding per breakpoint', () => {
    // clamp() is the mechanism the owner asked for by name: "a more sophisticated way to make the
    // spacings shrink with the screen width". A second padding declaration means a step.
    const padDecls = [...css.matchAll(/\.prod-cq \.products-table t[dh]\s*\{[^}]*padding-inline:/g)];
    expect(padDecls.length, 'expected exactly the td and th rules').toBe(2);
    expect(css).toMatch(/\.prod-cq \.products-table td\s*\{[^}]*padding-inline:\s*clamp\(/);
    expect(css).toMatch(/\.prod-cq \.products-table th\s*\{[^}]*padding-inline:\s*clamp\(/);
  });

  it('lets no container query decide what the seller can see', () => {
    /**
     * The container asks the TABLE's width, and the table gets WIDER when the window gets
     * narrower — the rail hands back its column. Any visibility keyed to it therefore
     * oscillates, which is how a column came back after leaving.
     */
    expect(css).not.toMatch(/@container\s+prodtable/);
    expect(css).not.toMatch(/container-type:\s*inline-size/);
  });

  it('has exactly the three transitions he named, in order', () => {
    // Serial number, then SKU, then the card layout — each once, on the WINDOW so it cannot fire twice.
    const rowNum = /@media \(max-width: (\d+(?:\.\d+)?)px\)\s*\{[^}]*\.row-num\s*\{\s*display:\s*none/.exec(css);
    const sku = /@media \(max-width: (\d+(?:\.\d+)?)px\)\s*\{[^}]*\.sku-col\s*\{\s*display:\s*none/.exec(css);
    expect(rowNum, 'the serial number never goes').not.toBeNull();
    expect(sku, 'the SKU column never goes').not.toBeNull();
    expect(
      Number(rowNum![1]),
      'the serial number must go BEFORE the SKU — it is the only column that says nothing about the product',
    ).toBeGreaterThan(Number(sku![1]));
    // And the card layout is below both.
    expect(css).toMatch(/@media \(max-width: 640px\)/);
  });

  it('never lets the SKU leave the row, only its column', () => {
    // The same query that drops the column reveals the copy under the product name.
    const block = /@media \(max-width: \d+(?:\.\d+)?px\)\s*\{[^}]*\.sku-col\s*\{\s*display:\s*none;[^}]*\}[^}]*\}/.exec(css);
    expect(block, 'could not find the SKU toggle').not.toBeNull();
    expect(block![0]).toContain('.product-sku-inline { display: block; }');
  });

  it('shortens the longest heading rather than widening a low-value column', () => {
    // "נוסף בתאריך" is the longest heading in the table and the only one that could not stay
    // readable in the narrow state on width alone — 65% of it visible at 660px. The short form
    // already existed for the mobile card.
    expect(css).toMatch(/\.date-label--short\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.date-label--long\s*\{\s*display:\s*none/);
    const markup = read('src/pages/seller/dashboard.astro');
    expect(markup).toContain('date-label--long');
    expect(markup).toContain('date-label--short');
  });
});
