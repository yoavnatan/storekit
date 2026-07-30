/** How a sale's category scope is WORDED — one rule for the storefront banner and for the
 *  dashboard preview that promises what the banner will say.
 *
 *  Names, not a generic "on selected categories": a named category is something the shopper can
 *  act on ("on all the shoes") and tells them in one glance whether the sale touches what they
 *  came for. Past a couple of names that stops being true — the line wraps on a 375px banner and
 *  starts competing with the seller's own sentence beside it — so the tail collapses into a
 *  count. The count is deliberately not dropped silently: "and 2 more" still says the sale is
 *  wider than what is listed.
 *
 *  Pure and isomorphic (no category tree, no DB) so the browser-side picker label and the
 *  server-rendered banner can't word the same sale differently.
 */

/** How many names are spelled out before the rest become a count. Two fits one line at 375px
 *  next to the percent chip; three did not. */
export const SCOPE_NAMES_SHOWN = 2;

/**
 * @param names  Category names in the seller's own pick order — a single pick may be a full
 *               path ("Shoes › Sport"), which disambiguates when there's room for it.
 * @param andMore Translated "and {n} more"; `{n}` is substituted.
 */
export function formatScopeNames(names: string[], andMore: string, shown = SCOPE_NAMES_SHOWN): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (!clean.length) return '';
  if (clean.length <= shown) return clean.join(', ');
  const rest = clean.length - shown;
  return `${clean.slice(0, shown).join(', ')} ${andMore.replace('{n}', String(rest))}`;
}
