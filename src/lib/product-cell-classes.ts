/**
 * Classes shared by the TWO renderers of a products-table row.
 *
 * **There are two, and forgetting that shipped a change that was invisible on every fresh page
 * load** (owner, 2026-08-22: *"אני בכלל לא רואה את הקו המקווקו שעשית לאינפוטים שאפשר לערוך
 * אינליין, בטוח שהכנסת את זה?!"* — and it was in, in one of the two places). `seller/dashboard.astro`
 * server-renders the first page of rows; `scripts/dashboard/products.ts#buildRows` builds every row
 * after that — a filter, a sort, a page change, a new product. The two agree on the markup by hand,
 * so anything added to one and not the other is correct exactly until the seller touches a control,
 * which is the worst possible shape for a bug: it looks like the change did not land, and it looks
 * like it landed the moment you go looking for it.
 *
 * This module is the half of that agreement a rule can live in. It holds classes only — no DOM, no
 * imports — so the `.astro` frontmatter can read it on the server without pulling a browser module
 * in with it. `tests/inline-edit-hint.test.ts` greps both renderers and fails if either stops using
 * it.
 */

/**
 * **The hint that a cell can be edited where it stands.**
 *
 * The whole announcement used to be `cursor-text`, which a seller sees only if the pointer is
 * already on the value and they happen to look at the cursor. A dotted underline under that same
 * value is the browser's own long-standing mark for "this text is not just text" — already in the
 * system rather than invented for this table, dated to nothing, right for a tool shop and a
 * boutique alike, and it spends no accent colour (design line, all four tests).
 *
 * On the CELL, not the row: the row already has its own hover fill, and three cells lighting up
 * together would say "this row is editable" when what is true is "these three values are".
 *
 * No `:not([data-inline-active])` guard is needed for the open state — while a cell is being edited
 * its contents are an `<input>` and a `<button>`, both atomic inline boxes, which `text-decoration`
 * does not draw on.
 *
 * Pointer-only by construction: `:hover` never fires on a touch screen, so the phone's card list is
 * unchanged. There is no quiet way to say this on touch; it would take standing prose above the
 * list, which this dashboard does not do.
 */
export const INLINE_EDIT_HINT =
  'hover:underline hover:decoration-dotted hover:decoration-[color:var(--color-muted)] hover:underline-offset-[3px] hover:decoration-1';

/**
 * The same hint for the stock cell, which is editable in place only while the product has no
 * variants — once it does, its total is a computed sum and the seller edits it per combo. The
 * click handler refuses that case (`initInlineEdit`, on `data-has-variants`), so the mark has to
 * refuse it too or it would be promising something the cell will not do.
 */
/**
 * **The stock cell needs a GROUP, because a plain hover-underline cannot reach its number.**
 *
 * Measured, after the owner reported the mark missing there twice: hovering the `<td>` really does
 * compute `text-decoration: underline dotted` on the `<td>`. It stops there. The cell's contents
 * sit in a `display:inline-flex` wrapper (the number, the low-stock icon and the breakdown chevron
 * have to sit on one line), and an inline-flex box is an atomic inline-level box — decoration does
 * not propagate into one. The same rule that keeps the underline off the `<input>` while the cell
 * is being edited was silently keeping it off the number the rest of the time.
 *
 * So the `<td>` becomes the group and the mark lands on the element that actually holds the text.
 * `stockCellGroup` goes on the cell; `stockEditHint` goes on `[data-stock-total]`.
 */
export const STOCK_CELL_GROUP = 'group/stk';

/**
 * The mark for a stock total, on `[data-stock-total]` — empty for a product with variants, whose
 * total is a computed sum that the click handler refuses (`initInlineEdit`, on `data-has-variants`).
 * That product is edited per combo instead; see `COMBO_STOCK_VALUE`.
 */
export function stockEditHint(hasVariants: boolean): string {
  return hasVariants
    ? ''
    : 'group-hover/stk:underline group-hover/stk:decoration-dotted'
      + ' group-hover/stk:decoration-[color:var(--color-muted)] group-hover/stk:underline-offset-[3px]'
      + ' group-hover/stk:decoration-1';
}

/**
 * **One combo's stock inside the breakdown dropdown — the OTHER thing that is click-to-edit**
 * (owner, 2026-08-22: *"אבל למה אין קו מקווקו על המלאי שכן אפשר לערוך inline? (לא את כולם אפשר
 * לערוך…)"*).
 *
 * A product with variants is exactly the case where the cell above refuses — its total is a
 * computed sum — and the editing moved here, to a number per combo. So this is where the hint has
 * to be for that product, and it was the one editable value on the page still saying nothing.
 *
 * A named group rather than a plain `hover:` on the number: the clickable area is the whole row-end
 * (`data-combo-stock-hit` — the number, the "pool" mark and the warning slot), and a mark that
 * lights only while the pointer is over the two digits themselves would keep disappearing on the
 * way to the click. The mark still lands on the NUMBER, because the number is what changes.
 */
export const COMBO_STOCK_HIT = 'cursor-text group/cstock';
export const COMBO_STOCK_VALUE =
  'py-[0.15rem] min-w-[1.9rem] text-end group-hover/cstock:underline group-hover/cstock:decoration-dotted'
  + ' group-hover/cstock:decoration-[color:var(--color-muted)] group-hover/cstock:underline-offset-[3px]'
  + ' group-hover/cstock:decoration-1';
