import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NO CELL MAY DRAW OVER ITS NEIGHBOUR.
 *
 * Owner, 2026-08-23, watching a date sit on top of the SEO gauge and then a price on top of the
 * stock: *"אני מניח שבמספרים גבוהים הכל עולה על הכל שם. חשבתי שיש הפרדה בין העמודות."* There was
 * none. `.num` cells are `white-space: nowrap` and nothing bounded them, so a value wider than its
 * column did not truncate — it drew across the neighbour. The columns only looked separate because
 * the demo catalogue's numbers are short.
 *
 * That is the oldest note about this table, from before any of the day's work: five columns could
 * not hold their worst-case content and it *"does not look broken today only because .num cells are
 * nowrap and the number spills into the neighbour's padding"*. **The spill was what hid the
 * shortfall**, which is why the fix is worth a test of its own: without it, the next column that
 * becomes too narrow goes unnoticed again.
 *
 * The rule is on the CELL, not on the columns that happened to be caught, so a column added later
 * inherits it.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const css = read('src/styles/pages/dashboard.css');

describe('products table cells contain their own content', () => {
  it('clips and ellipsises every cell by default', () => {
    expect(css).toMatch(/\.prod-cq \.products-table td\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.prod-cq \.products-table td\s*\{[^}]*text-overflow:\s*ellipsis/);
  });

  it('exempts the columns that hold a CONTROL rather than text', () => {
    /**
     * Ellipsis means "there is more text here". A checkbox, a gauge and a kebab have no more, so
     * clipping one is only ever damage — measured before this exemption existed: at 1440 the gauge
     * and the kebab each sat 2px past their cell's start edge and were being shaved.
     */
    const exempt = /\.prod-cq \.products-table \.seo-col,\s*\n?\s*\.prod-cq \.products-table \.actions-col\s*\{[^}]*overflow:\s*visible/;
    expect(css, 'the gauge and the kebab would be clipped by the cell rule above').toMatch(exempt);
    // The checkbox was already exempt, for its focus ring; that must survive too.
    expect(css).toMatch(/\.check-col\s*\{[^}]*overflow:\s*visible/);
  });

  it('gives the columns whose worst case does not scale a fixed floor', () => {
    /**
     * A price and a date have a hard worst case — "₪ 149,900.00" is 95px whatever the window does —
     * so a percentage cannot promise they fit, and a truncated price is a number a seller cannot
     * read. Measured against what the RENDERER emits, not against invented values: likes and
     * purchases go through `compactCount`, which caps at five characters ("999.9K"), so those two
     * are correctly narrow and sizing them for "54,321" would have been sizing for a string the
     * code cannot produce.
     */
    for (const col of ['price-col', 'date-col', 'stock-col']) {
      const m = new RegExp(`\\.products-table \\.${col}\\s*\\{\\s*width:\\s*([\\d.]+)(rem|%)`).exec(css);
      expect(m, `${col} has no width`).not.toBeNull();
      expect(m![2], `${col} must have a floor in rem, not a share that shrinks under its content`).toBe('rem');
    }
  });
});
