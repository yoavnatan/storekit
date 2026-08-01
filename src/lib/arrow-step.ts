/**
 * Which way a horizontal arrow key should move through a source-ordered list.
 *
 * An arrow key names a direction ON SCREEN. This site renders RTL, where a row
 * runs right→left, so ArrowRight has to walk BACKWARD through the DOM to land
 * on the item that is actually to the right. Getting this wrong doesn't look
 * like a bug in code review — it looks correct — and it only shows up as
 * "the arrows do the opposite thing" once someone drives the UI in Hebrew
 * (owner, 2026-08-01, on the homepage tab strip).
 *
 * It had already been solved once, inline, on the product page's lightbox
 * (`pageLang === 'he' ? 1 : -1`) and missed in three other places that navigate
 * a horizontal list with arrows. Hence one copy, here.
 *
 * Direction is read from the element rather than from the language: the two are
 * the same thing today, but `direction` is what actually decides which way the
 * pixels went, and it needs no rebinding when the language toggle flips.
 *
 * @param key  A KeyboardEvent's `key`.
 * @param el   Any element inside the list — its computed `direction` is used.
 * @returns `+1` to move forward through the list in source order, `-1` to move
 *          backward, and `0` when the key is not a horizontal arrow at all.
 */
export function arrowStep(key: string, el?: Element | null): number {
  if (key !== 'ArrowRight' && key !== 'ArrowLeft') return 0;
  const target = el ?? (typeof document !== 'undefined' ? document.documentElement : null);
  const rtl = !!target && getComputedStyle(target).direction === 'rtl';
  const forward = key === 'ArrowRight' ? 1 : -1;
  return rtl ? -forward : forward;
}

/** Step `index` by `step` through a list of `length`, wrapping at both ends. */
export function wrapIndex(index: number, step: number, length: number): number {
  return (index + step + length) % length;
}
