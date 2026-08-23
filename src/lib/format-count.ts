/**
 * A COUNT, shortened so a column can be sized for it — "1.2K", "12.3K", "999K", "1.2M".
 *
 * Owner, 2026-08-23, on five products-table columns that cannot hold their own worst reasonable
 * content: *"ולקצר מספרים מ-1000 ומעלה ל-'1.2K'"*.
 *
 * **What this is really for is the COLUMN, not the number.** A count with no upper bound needs a
 * column with no upper bound, and there isn't one — so a table sized for "the biggest number we
 * imagined" is a table that breaks the first time a seller exceeds it. Five characters is the most
 * this can ever return, whatever the input, which is what lets `.wishlist-col` and
 * `.purchased-col` be fixed widths that are provably enough (dashboard.css).
 *
 * **Never for money, and never for stock.** Two hard limits, and both are the kind that only look
 * like style until they cost something:
 *   · money goes through `lib/money.ts` and is never approximated — the guard tests scan the whole
 *     tree for exactly this, and a rounded shekel figure in a seller's face is the class of defect
 *     memory `project_metric_integrity_audit` exists about;
 *   · stock is EDITABLE IN PLACE. The inline editor seeds its input from the cell's own
 *     `textContent` (`products.ts`, `prevStock`), so an abbreviated total would arrive at the
 *     server as the string "12.3K" — `Number()` of which is NaN, and `|| 0` of that is a stock of
 *     zero, sent as the optimistic-concurrency check on an inventory write. Stock keeps its digits;
 *     its column is sized by padding instead.
 * `tests/format-count.test.ts` pins both the output and those two exclusions.
 *
 * The exact figure is never lost: every call site renders it as the element's `title`, so the
 * number a seller needs to act on is one hover away and is what a copy/paste takes.
 *
 * Latin K/M rather than `Intl.NumberFormat(lang, {notation:'compact'})`, which in Hebrew returns
 * "1.2 אלף" — three characters WIDER than the digits it replaces, in the one direction this exists
 * to move. He named "1.2K" and it is the same token in both languages.
 */

/** At most five characters, for any finite input. Negatives are not a count and come back as "0". */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const v = Math.floor(n);
  if (v < 1000) return String(v);
  // `T` is not a real case and it is not decoration: without it, a number past a billion falls
  // through to `String(v)` and the five-character ceiling this whole function promises stops being
  // true — `Number.MAX_SAFE_INTEGER` came back eight characters wide. A ceiling with an exception
  // is not a ceiling, and the column widths are sized against it.
  for (const [unit, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (v < unit) continue;
    const scaled = v / unit;
    // One decimal only while it still says something — "1.2K" carries a digit "12K" would lose,
    // "123.4K" does not, and it is the character this whole function is trying to save.
    const text = scaled < 10 ? (Math.floor(scaled * 10) / 10).toFixed(1) : String(Math.floor(scaled));
    return `${text}${suffix}`;
  }
  return String(v);
}

/** True when `compactCount` would hide digits — i.e. when the exact figure has to be offered
 *  somewhere else (a `title`). Kept here so no call site has to remember the threshold. */
export function isCompacted(n: number): boolean {
  return Number.isFinite(n) && n >= 1000;
}
