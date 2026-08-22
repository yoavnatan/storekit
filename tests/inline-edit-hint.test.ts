/**
 * The products row has TWO renderers, and a change made to one of them is invisible in exactly the
 * way that reads as "you didn't do it".
 *
 * `seller/dashboard.astro` server-renders the first page of rows; `products.ts#buildRows` builds
 * every row after that — a filter, a sort, a page change, a new product. When the inline-edit hint
 * was added on 2026-08-22 it went into the client one only, so a freshly loaded dashboard had none
 * of it and the owner reported the change as missing ("אני בכלל לא רואה את הקו המקווקו… בטוח
 * שהכנסת את זה?!"). It WAS in — in one of the two places, which is the worst shape a UI bug takes:
 * it looks absent on arrival and appears the moment you touch a control.
 *
 * The shared source of truth is `lib/product-cell-classes.ts`. This test is the half that makes it
 * stay shared: it checks the three editable cells in BOTH renderers, and it checks by SHAPE — a
 * cell that hard-codes the class string instead of importing it would satisfy a "the classes are
 * there" test while re-opening the drift on the next edit.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMBO_STOCK_HIT, COMBO_STOCK_VALUE, INLINE_EDIT_HINT, STOCK_CELL_GROUP, stockEditHint } from '../src/lib/product-cell-classes.js';

const PAGE = readFileSync(join(process.cwd(), 'src/pages/seller/dashboard.astro'), 'utf8');
const SCRIPT = readFileSync(join(process.cwd(), 'src/scripts/dashboard/products.ts'), 'utf8');

/** The line each renderer writes for one cell, found by the class that identifies that cell. */
function cellLine(source: string, marker: string): string {
  const line = source.split('\n').find((l) => l.includes(marker));
  expect(line, `no line carrying ${marker}`).toBeDefined();
  return line!;
}

const RENDERERS: Array<[string, string]> = [
  ['seller/dashboard.astro (server, the first page of rows)', PAGE],
  ['scripts/dashboard/products.ts (client, every row after that)', SCRIPT],
];

describe('both product-row renderers announce the inline edit', () => {
  for (const [name, source] of RENDERERS) {
    it(`${name} — the product name`, () => {
      expect(cellLine(source, 'product-name cursor-text')).toContain('INLINE_EDIT_HINT');
    });

    it(`${name} — the price`, () => {
      expect(cellLine(source, 'product-price price-col')).toContain('INLINE_EDIT_HINT');
    });

    it(`${name} — the stock, on the element that actually holds the number`, () => {
      // The cell is the GROUP and the mark lands inside it, because the cell's contents sit in an
      // `inline-flex` wrapper and `text-decoration` does not cross an atomic inline box — measured,
      // after the mark was reported missing here twice.
      expect(cellLine(source, 'product-stock stock-col')).toContain('STOCK_CELL_GROUP');
      // And through the helper, not the raw classes: click-to-edit only while the product has no
      // variants, and a mark on a cell that will not open is a promise the click handler breaks.
      expect(cellLine(source, 'data-stock-total')).toContain('stockEditHint(');
    });

    it(`${name} — one combo's stock inside the breakdown dropdown`, () => {
      // The case the cell above refuses: a product with variants edits its stock per combo, so for
      // that product this is the only editable number on the page. It was the one that still said
      // nothing.
      expect(cellLine(source, 'data-combo-stock-hit')).toContain('COMBO_STOCK_HIT');
      expect(cellLine(source, 'data-combo-stock-value')).toContain('COMBO_STOCK_VALUE');
    });

    it(`${name} — imports the shared classes rather than repeating them`, () => {
      expect(source).toContain("from '../../lib/product-cell-classes.js'");
      // The literal utility must appear in exactly one place in the tree, and it is not here.
      expect(source).not.toContain('hover:decoration-dotted');
    });
  }
});

describe('the shared classes themselves', () => {
  it('draw a dotted underline in the muted colour, and nothing louder', () => {
    // Pinned because the design argument is the specific one: an existing browser convention, no
    // accent colour spent. A future edit that reaches for a colour should have to change this line
    // and read why.
    expect(INLINE_EDIT_HINT).toContain('hover:underline');
    expect(INLINE_EDIT_HINT).toContain('hover:decoration-dotted');
    expect(INLINE_EDIT_HINT).toContain('var(--color-muted)');
  });

  it('says nothing on a stock total whose product has variants', () => {
    expect(stockEditHint(true)).toBe('');
    // Its own group-hover set, driven by STOCK_CELL_GROUP on the cell — not the plain hover hint,
    // which cannot reach this element through the inline-flex wrapper above it.
    expect(stockEditHint(false)).toContain('group-hover/stk:underline');
    expect(stockEditHint(false)).toContain('group-hover/stk:decoration-dotted');
    expect(STOCK_CELL_GROUP).toBe('group/stk');
  });

  it('marks the combo number from the whole clickable area, not from the digits alone', () => {
    // The pair has to agree on the group's name or the mark never fires: `group/cstock` on the hit
    // area, `group-hover/cstock:` on the number.
    expect(COMBO_STOCK_HIT).toContain('group/cstock');
    expect(COMBO_STOCK_VALUE).toContain('group-hover/cstock:underline');
    expect(COMBO_STOCK_VALUE).toContain('group-hover/cstock:decoration-dotted');
  });
});
