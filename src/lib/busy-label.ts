/**
 * The text that may sit beside three animating dots.
 *
 * **Six dots, twice.** Every "working" label in this codebase is written with a trailing ellipsis
 * — `deleting: 'מוחק...'`, `'מסיר רקע…'`, `'משהה…'` — and the `.dot-pulse` beside it draws three
 * more that actually move. ConfirmModal learned that on 2026-08-17 and stripped the ellipsis with
 * `/[\s.…]+$/`, anchored at the END of the string. Which held until a caller composed one:
 *
 *     workingLabel: `${i.deleting ?? 'מוחק...'} (${count})`   // products.ts, bulk delete
 *
 * That string ends in `)`, so the strip matched nothing and the button read **"מוחק... (3) ⋯"** —
 * the owner's report, 2026-08-18, and rightly exasperated: the fix was already in and the bug was
 * still on screen. `busyButton` had the same hole from the other side — it stripped the ellipsis
 * only for the label it appends a PERCENTAGE to, and rendered the raw one before any progress
 * arrived.
 *
 * So the rule stops being "trim the end" and becomes what it always meant: **a label shown next to
 * the dots carries no ellipsis of its own, wherever it sits.** And it lives in ONE function that
 * both in-flight surfaces call, rather than in a regex each of them keeps its own copy of — a
 * caller cannot defeat it by composition, because composition happens before this runs.
 *
 * Callers keep writing their dictionaries with the ellipsis, deliberately: the same string is also
 * used where there are no dots, and there it should still trail off.
 */

/** Any run of two-or-more dots, or a `…`, plus the whitespace holding it on. */
const ELLIPSIS = /\s*(?:\.{2,}|…)/gu;

export function busyLabel(text: string): string {
  return text.replace(ELLIPSIS, '').replace(/\s{2,}/gu, ' ').trim();
}
