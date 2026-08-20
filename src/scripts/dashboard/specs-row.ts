/**
 * One row of the product's specification editor — a name, a value, and a way to remove it.
 *
 * **It lives here because it existed three times**, in `products.ts#specsEditorHtml` (the rows the
 * server's product data renders), `products.ts#initSpecsEditors` (the row "+ הוסף שורה" appends)
 * and `spec-suggest.ts` (the row a suggested attribute creates). Three copies of one piece of
 * markup is the shape AI_INSTRUCTIONS names as "the next bug", and it was: every one of them
 * hard-coded `width:170px` / `width:220px` with `flex:0 0 auto`, so on a phone the row's 440px of
 * fixed widths sat in a 333px box and simply left the screen — measured at 375px, the value field
 * started 44px past the left edge and the × was 82px beyond it, i.e. not reachable at all
 * (owner, 2026-08-20: *"רוחב: 20 (ואיקס למחיקה) זה מה שיוצא לי מהשטח"*). In RTL that overflow does
 * not even produce a scrollbar to go and find them.
 *
 * Below `sm` the widths are a RATIO rather than a measurement — flex bases in the same 170:220
 * proportion, which shrink to whatever the row has. `min-w-0` is the part that is easy to leave out
 * and pointless to leave out: a flex item's default `min-width:auto` refuses to shrink below its
 * content, which is how an input with a long value pushes its siblings off the screen.
 *
 * **Above `sm` the original 170px / 220px come back**, deliberately. There is plenty of room there,
 * and letting a pair of short values ("חומר: ויסקוזה") stretch across a 1000px row is a worse
 * answer than the fixed one — the change here is about a phone, and it should not become a change
 * about a desktop by accident.
 *
 * `tests/specs-row-single-source.test.ts` fails if a fourth copy is hand-rolled anywhere in `src/`.
 */

export interface SpecsRowStrings {
  labelPlaceholder: string;
  valuePlaceholder: string;
  removeLabel: string;
}

/** The class list for the row's own element — `.specs-row` is what every reader keys off. */
export const SPECS_ROW_CLASS = 'specs-row flex flex-wrap items-center gap-2 mb-2';

/**
 * The row's contents. `esc` is passed in rather than imported so this file serves both callers
 * without either of them changing which escaper it uses — products.ts and spec-suggest.ts reach
 * the same `lib/html-escape.ts` under different local names.
 */
export function specsRowHtml(
  label: string,
  value: string,
  s: SpecsRowStrings,
  esc: (v: string) => string,
): string {
  return `
    <input class="input flex-[1_1_7rem] min-w-0 sm:flex-none sm:w-[170px]" name="specs_label" value="${esc(label)}" placeholder="${esc(s.labelPlaceholder)}">
    <input class="input flex-[1_1_9rem] min-w-0 sm:flex-none sm:w-[220px]" name="specs_value" value="${esc(value)}" placeholder="${esc(s.valuePlaceholder)}">
    <button type="button" class="specs-remove-row btn btn--ghost btn--sm shrink-0" aria-label="${esc(s.removeLabel)}">×</button>`;
}
