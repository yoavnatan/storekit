import { starFills, ratingDisplay, averageRating, type RatingAggregate } from './reviews.js';
import { escapeHtml } from './html-escape.js';

/**
 * A star row, as an HTML STRING — the one renderer of stars anywhere on this site.
 *
 * ── Why a string helper and not only a component ──
 * The store grid is rendered TWICE: once by `[storeSlug]/index.astro` and once in JavaScript, by
 * the same file's "טען עוד" card builder. So is the homepage shelf. A component can only serve the
 * first, and stars added to the template alone would simply vanish from every card past the first
 * page — silently, and only for the shopper who scrolled. Same reason `priceHtml` and
 * `saleBadgeHtml` next door are string helpers: the twin exists, so the fix is one function both
 * twins call, never two careful copies (memory `project_brand_boost_twin_drift`).
 *
 * `StarRating.astro` is a thin wrapper over this, so the product page's summary and a card in a
 * grid cannot draw a different star.
 *
 * ── The two rules the markup encodes ──
 * A half star is an empty star with a filled one laid over it, clipped to half its width — no SVG
 * gradient, because a gradient needs a document-unique id and this renders a dozen times per page.
 * And the row is `dir="ltr"` even on an RTL page: a half star only reads correctly if "full" starts
 * at a known end, and 4.5 as four-and-a-half stars left to right is the borrowed idiom's own
 * grammar. The NUMBER beside it is text and stays in the page's direction.
 *
 * No rating renders NOTHING — not five empty stars, which read as a bad score rather than as none.
 */

export interface StarRowOptions {
  /** Star edge length in px. 13 on a card, 15 in a review row, 18 under a product title. */
  px?: number;
  /** Print the average (`4.5`) beside the stars. */
  showValue?: boolean;
  /** What to print for the count. `undefined` prints nothing; pass `(12)` on a card, or the worded
   *  "12 ביקורות" where there is room — the wording is the CALLER's, so this file holds no string
   *  that needs translating and no client twin can drift from `translations.ts`. */
  countLabel?: string;
  /** Accessible name for the whole row — the caller's, for the same reason. The stars themselves
   *  are `aria-hidden`: five "star" announcements are noise where the number is the information. */
  ariaLabel?: string;
  /** Wrap it in a link (the product page's summary points at its own reviews section). */
  href?: string;
}

/** The star outline itself, exported because the PICKER in `ReviewForm.astro` draws the same shape
 *  and a second copy of it is two stars that stop matching the day either is nudged. Guarded by
 *  `tests/star-markup-single-source.test.ts`, which fails on a second literal in `src/`. */
export const STAR_PATH = 'M12 2.6l2.9 5.88 6.5.95-4.7 4.58 1.11 6.47L12 17.43 6.19 20.48 7.3 14.01 2.6 9.43l6.5-.95z';

/**
 * One star: a pale SOLID star, with a gold one laid over the filled fraction and clipped to it.
 *
 * **Both layers are solid fills, and the first version's outline was a mistake.** A 1.5px stroke at
 * 13px — the size on a product card — renders as a smudge rather than a star, and the boundary of a
 * HALF star has to be unmistakable or the half-star rule may as well not exist. Two solid shapes
 * are crisp at every size this is used at.
 *
 * **Every dimension is pinned INLINE, and that is not belt-and-braces.** `reset.css` sets
 * `svg { max-width: 100%; height: auto }` for the whole site, which beats the `width`/`height`
 * ATTRIBUTES — so inside the 50%-wide clipping box the overlay SVG obeyed `max-width` and shrank to
 * half size, then `height:auto` scaled it down to match. The half star rendered as a small whole
 * star sitting on top of a big one, which is exactly what the owner reported (2026-08-17) and
 * exactly what memory `project_svg_height_auto_trap` already describes. `max-width:none` is the
 * half of the fix that is easy to leave out.
 */
function starHtml(fill: 'full' | 'half' | 'empty', px: number): string {
  const svg = (color: string) =>
    `<svg viewBox="0 0 24 24" fill="currentColor" style="display:block;width:${px}px;height:${px}px;max-width:none;color:${color}"><path d="${STAR_PATH}"/></svg>`;
  const base = `<span style="position:absolute;inset:0;line-height:0">${svg('var(--color-rating-empty)')}</span>`;
  const filled = fill === 'empty' ? '' :
    `<span style="position:absolute;inset:0;overflow:hidden;width:${fill === 'half' ? '50%' : '100%'};line-height:0">`
    + svg('var(--color-rating)')
    + '</span>';
  return `<span style="position:relative;display:inline-block;width:${px}px;height:${px}px;flex:0 0 auto">${base}${filled}</span>`;
}

/** `avg` is the AVERAGE (`reviews.ts#averageRating`), or null for a product nobody has rated —
 *  never a count and never a sum. Taking the number rather than the aggregate is what lets one
 *  review's own score reuse this row unchanged. */
export function starRowHtml(avg: number | null, options: StarRowOptions = {}): string {
  if (avg === null) return '';
  const { px = 15, showValue = false, countLabel, ariaLabel, href } = options;

  const stars = starFills(avg).map((fill) => starHtml(fill, px)).join('');
  const value = showValue
    ? `<span style="font-size:${px}px;font-weight:700;color:var(--color-text);line-height:1">${escapeHtml(ratingDisplay(avg))}</span>`
    : '';
  const count = countLabel
    ? `<span style="font-size:${px - 1}px;color:var(--color-muted);line-height:1">${escapeHtml(countLabel)}</span>`
    : '';

  const tag = href ? 'a' : 'span';
  const attrs = [
    'class="inline-flex items-center gap-1.5 align-middle"',
    `style="text-decoration:none;color:inherit;font-size:${px}px"`,
    href ? `href="${escapeHtml(href)}"` : 'role="img"',
    ariaLabel ? `aria-label="${escapeHtml(ariaLabel)}"` : '',
  ].filter(Boolean).join(' ');

  return `<${tag} ${attrs}>`
    + `<span dir="ltr" class="inline-flex items-center" style="gap:1px;line-height:0" aria-hidden="true">${stars}</span>`
    + value + count
    + `</${tag}>`;
}

/** The compact form every product CARD uses: stars, the average, and the count in brackets. Digits
 *  only — a card has no room for "12 ביקורות" and the brackets need no translation. */
export function cardStarRowHtml(agg: RatingAggregate, ariaLabel?: string): string {
  return starRowHtml(averageRating(agg), {
    px: 13,
    showValue: true,
    countLabel: agg.count > 0 ? `(${agg.count})` : undefined,
    ...(ariaLabel ? { ariaLabel } : {}),
  });
}
