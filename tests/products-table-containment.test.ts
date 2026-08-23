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

  it('gives every number column a floor in rem, and lets it grow into a wide screen', () => {
    /**
     * A price and a date have a hard worst case that does not scale with the window — `formatPrice`
     * can emit "149,900.50 ₪" and that is 108px whatever the viewport does — so a bare percentage
     * cannot promise they fit. But a bare rem cannot either, in the other direction: the previous
     * widths were roughly twice their content (the date held 109px to show 57px of date) and, being
     * fixed, they kept every pixel as the table narrowed until the name and the category had none
     * left — owner: *"ברוחב מסויים פשוט לא רואים את השם ואת הקטגוריה בכלל"*.
     *
     * So each is `clamp(floor, <n>vw, ceiling)`: the floor is what the typical value needs, the
     * ceiling is what the worst case needs, and the vw term walks between them. **vw and not a
     * percentage of the table** — the table gets WIDER as the window narrows past the rail's
     * collapse, so anything keyed to the table's own width oscillates (see
     * `products-table-states`); the viewport only ever moves one way.
     *
     * The date is the exception and stays a plain rem: `toLocaleDateString('he-IL', 2-digit×3)`
     * emits "31.12.26" and nothing else, so its worst case IS its typical one and there is nothing
     * for a wide screen to give it. Likes and purchases go through `compactCount`, capped at five
     * characters ("999.9K") — sizing them for "54,321" would be sizing for a string the code cannot
     * produce.
     */
    for (const col of ['price-col', 'date-col', 'stock-col', 'wishlist-col', 'purchased-col']) {
      const m = new RegExp(`\\.products-table \\.${col}\\s*\\{\\s*width:\\s*([^;]+);`).exec(css);
      expect(m, `${col} has no width`).not.toBeNull();
      const width = m![1].trim();
      const floor = /^clamp\(\s*([\d.]+)rem\s*,\s*([\d.]+)vw\s*,\s*([\d.]+)rem\s*\)$/.exec(width);
      if (floor) {
        expect(Number(floor[1]), `${col}'s ceiling must be above its floor`).toBeLessThan(Number(floor[3]));
      } else {
        expect(width, `${col} must be a rem floor or a clamp(rem, vw, rem), never a bare share`).toMatch(/^[\d.]+rem$/);
      }
    }
  });

  it('leaves the arbitrary-length columns as shares, so they take whatever is left', () => {
    /**
     * A product name, a SKU and a category path have no worst case to size for — they are as long
     * as the seller made them. They are the columns that SHOULD absorb the squeeze, because an
     * ellipsis in a name still reads and a clipped price does not. Percentages summing to 100%
     * across the three of them is what makes the leftover divide instead of one of them collapsing.
     */
    const shares = ['name-col', 'sku-col', 'cat-col'].map((col) => {
      const m = new RegExp(`\\.products-table \\.${col}\\s*\\{\\s*width:\\s*([\\d.]+)%`).exec(css);
      expect(m, `${col} must be a share`).not.toBeNull();
      return Number(m![1]);
    });
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
  });
});
