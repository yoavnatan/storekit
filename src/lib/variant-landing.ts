/**
 * The URL a variant feed row lands on, and the selection a product page reads back out of it.
 *
 * **The gap this closes (found 2026-08-06).** A product with variants emits NO parent row — one row
 * per combo, tied by `item_group_id` (product-feed.ts#buildFeedItems). Every one of those rows
 * published the SAME `link`, and the product page deliberately pre-selects nothing ("no default
 * pre-selection", [productSlug].astro), so a shopper who clicked a paid ad for a specific red /
 * size-42 row landed on a page with nothing chosen and had to find that combination again. Not a
 * disapproval — a validator sees a working URL — which is exactly why it could sit there: every
 * side was individually correct and only the JOIN between the row and its landing was missing.
 *
 * **Why a query parameter and not a path.** The combo is not part of the product's identity: it is
 * one product, one canonical page, one set of accumulated ranking. A path segment would mint a real
 * URL per combination and split that ranking N ways, and it would need a route that resolves an
 * arbitrary Hebrew combination string before it could 404 correctly. A parameter the page treats as
 * a HINT keeps the page one page — see `parseVariantLanding`, which is written so an unparseable
 * value degrades to "nothing selected", i.e. exactly the old behaviour.
 *
 * **The value is the `comboKey`, verbatim.** That is what makes this reversible without a lookup
 * table: the same string the feed row's id is built from (`ad-item-id.ts#adComboItemId`), the same
 * string `variantStock` is keyed by. A second spelling would be a second thing to keep in sync, and
 * the feed has already been bitten once by exactly that (see `ad-item-id.ts`'s header).
 */
import { comboKey, type VariantSelection, type VariantDimension } from './variant-combo.js';

/**
 * The query parameter carrying the pre-selected combo. One character, because it rides alongside
 * `ad=1` on every custom-domain store's ad link and both are in the address bar a shopper sees.
 */
export const VARIANT_PARAM = 'v';

/**
 * Longest `v` value that will be looked at. A combo key is bounded by the product's own dimensions
 * (variant-combo.ts#MAX_VARIANT_COMBOS bounds the count, and option values are seller text), so
 * 600 is far above any real key — this is here for the value that is NOT a real key: a hand-crafted
 * URL. Everything below splits rather than matches a pattern, so there is no quadratic regex to
 * stall on, but there is no reason to split a megabyte either.
 */
const MAX_PARAM_LENGTH = 600;

/**
 * `link` with the combo appended — the URL one feed row publishes.
 *
 * Appended to whatever the caller already built rather than composed from parts, because that link
 * is `custom-domain.ts#adLandingUrl`'s output and may already carry `?ad=1`. Building it here from
 * a base would be a second answer to "where does this store's ad land", which is the mistake
 * `FeedBuildContext.productLink` exists to prevent.
 */
export function variantLandingUrl(link: string, selection: VariantSelection): string {
  const key = comboKey(selection);
  if (!key) return link;
  const sep = link.includes('?') ? '&' : '?';
  return `${link}${sep}${VARIANT_PARAM}=${encodeURIComponent(key)}`;
}

/**
 * The selection a page should start with, given the request URL and the product's real dimensions.
 *
 * **Every unknown is dropped, and dropping is never an error.** The parameter is a hint from an ad
 * click, so the failure mode has to be the page it would have rendered anyway — not a 404, not a
 * partial state the shopper cannot see the cause of. So:
 *  - a value over the cap, absent, or empty     → `{}`
 *  - a pair naming a dimension the product does not have → that pair dropped
 *  - a pair whose value is not one of that dimension's options → that pair dropped
 *  - a dimension named twice                    → first wins, and a page never shows two selections
 *    for one rubric
 *
 * A dropped pair leaves its dimension UNSELECTED rather than falling back to a default, which keeps
 * the add-to-cart guard (`flagMissingVariants`) honest: the buyer is asked for the choice that was
 * never validly made, instead of silently buying an option the URL did not name.
 *
 * Note it does not care whether the result is a COMPLETE combo. A partial selection is a legitimate
 * state on this page — the buyer arriving mid-choice is what every swatch click produces — and an
 * ad row's own key is always complete anyway.
 */
export function parseVariantLanding(url: URL, variants: VariantDimension[] | undefined): VariantSelection {
  const raw = url.searchParams.get(VARIANT_PARAM);
  if (!raw || raw.length > MAX_PARAM_LENGTH || !variants?.length) return {};

  // Indexed by name so a product with many dimensions costs one pass, not one scan per pair.
  const byName = new Map(variants.filter((v) => v.name && v.options.length).map((v) => [v.name, new Set(v.options)]));
  const selection: VariantSelection = {};
  for (const pair of raw.split(',')) {
    // `indexOf`, not `split('=')`: an option value may legitimately contain '=' (a size like
    // "40=41" is seller free text), and only the FIRST separator is structural.
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (name in selection) continue;
    if (!byName.get(name)?.has(value)) continue;
    selection[name] = value;
  }
  return selection;
}
