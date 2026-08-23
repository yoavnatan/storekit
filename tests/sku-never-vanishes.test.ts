import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE SKU IS AN IDENTIFIER, SO IT IS ON SCREEN AT EVERY WIDTH.
 *
 * Owner, 2026-08-23: *"המקט לא יכול פשוט להעלם מעל פני האדמה"*. Before this, it did — measured on
 * the running dashboard across fourteen viewport widths, the value was unreachable in TWO whole
 * bands (a 1200-1290px window and a 700-1040px one) and flipped in and out four times on the way
 * down. The column drop itself is correct and measured (dashboard.css records what keeping it
 * cost); what was wrong is that the VALUE went with the column.
 *
 * So a row now carries the SKU twice — once in `.sku-col`, once as `.product-sku-inline` under the
 * product name — with CSS showing exactly one of them. **Two copies of one value is a drift hazard,
 * and this file is the price of it.** The failure it exists to stop is not hypothetical here: this
 * table's edit form PATCHES cells rather than rebuilding the row, so a renderer that updates one
 * copy and not the other leaves a row displaying the old SKU below 960px and the new one above it —
 * silently, and only at some window sizes.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/** Every file that writes a `sku-col` cell must also write the copy under the name. */
const RENDERERS = ['src/pages/seller/dashboard.astro', 'src/scripts/dashboard/products.ts'];

describe('the SKU never leaves the row', () => {
  it('is rendered in both places by every renderer that renders it at all', () => {
    for (const file of RENDERERS) {
      const src = read(file);
      const colWrites = (src.match(/sku-col/g) ?? []).length;
      const inlineWrites = (src.match(/product-sku-inline/g) ?? []).length;
      expect(colWrites, `${file} renders no sku column — did it move?`).toBeGreaterThan(0);
      expect(
        inlineWrites,
        `${file} writes .sku-col but never .product-sku-inline — the SKU disappears below 960px`,
      ).toBeGreaterThan(0);
    }
  });

  it('patches the copy under the name wherever it patches the column', () => {
    // The edit-save path is the one that patches rather than rebuilds. Both writes must be there.
    const src = read('src/scripts/dashboard/products.ts');
    expect(src).toMatch(/querySelector<HTMLElement>\('\.sku-col'\)/);
    expect(src).toMatch(/querySelector<HTMLElement>\('\.product-sku-inline'\)/);
    // And clearing a SKU must remove the line rather than leave a stale one.
    expect(src).toMatch(/skuLine\?\.remove\(\)/);
  });

  it('shows exactly one of the two at any width', () => {
    /**
     * Three rules decide this and they are spread across one file, so they are asserted together:
     *   · base            — the line under the name is hidden
     *   · @container ≤960 — the column goes, the line appears
     *   · @media ≤640     — the card gives the column its own row back, so the line goes again
     *
     * The third is LATER in the file at the SAME specificity as the second, which is the only
     * reason it wins. Reordering the file would duplicate the SKU on every phone card, with
     * nothing to notice — which is precisely why this is pinned rather than left to reading.
     */
    const css = read('src/styles/pages/dashboard.css');

    const base = css.indexOf('.product-sku-inline {');
    const reveal = css.indexOf('.products-table .product-sku-inline { display: block; }');
    const cardHide = css.indexOf('.products-table .product-sku-inline { display: none; }');

    expect(base, 'no base rule for .product-sku-inline').toBeGreaterThan(-1);
    expect(reveal, 'nothing reveals the SKU line when its column is dropped').toBeGreaterThan(-1);
    expect(cardHide, 'nothing hides the SKU line on the mobile card').toBeGreaterThan(-1);
    expect(
      cardHide,
      'the card rule must come AFTER the reveal — same specificity, so source order is what decides',
    ).toBeGreaterThan(reveal);

    /**
     * THE REVEAL MUST SIT IN THE VERY QUERY THAT DROPS THE COLUMN — that is the invariant, and
     * it is deliberately not tied to which query that is. It was a container query until
     * 2026-08-23 and is a viewport media query now (the table's three states); pinning the
     * mechanism rather than the pairing made this test fail on a refactor that kept the
     * behaviour perfectly intact, which is a test failing for the wrong reason.
     *
     * So: find whichever block hides `.sku-col`, and require the reveal inside that same block.
     */
    const drop = /@[a-z-]+[^{]*\{[^{}]*\.products-table \.sku-col\s*\{\s*display:\s*none;[\s\S]*?\n\}/.exec(css);
    expect(drop, 'nothing drops the SKU column at all').not.toBeNull();
    expect(
      drop![0],
      'the column is dropped without the line under the name appearing — the SKU would be off screen',
    ).toContain('.product-sku-inline { display: block; }');
  });
});
