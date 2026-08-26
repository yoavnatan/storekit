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
 * **And the row MIRRORS with the page — it does not pin `dir="ltr"` (corrected 2026-08-17).** It
 * did, on the argument that a half star only reads if "full" starts at a known end and that a star
 * rating is a borrowed idiom carrying its own left-to-right grammar. The owner asked what the
 * convention actually IS, and the answer goes the other way: a rating is a SCALE, and both Material
 * Design's bidirectionality guidance and Microsoft's mirroring guidance say a scale or a
 * progression mirrors — in RTL a progression runs right to left. "It is borrowed" is a weak
 * argument on a Hebrew-first site that mirrors everything else it owns, down to the arrow keys.
 *
 * Nothing here had to change for it: the flex row lays its stars out in the page's direction, and
 * the fill span is `inset:0` plus a `width`, which over-constrains left/right — so the browser
 * drops the START edge and the clip anchors to the reading side of its own accord, either way.
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
 * exactly what memory `project_css_cascade_traps` already describes. `max-width:none` is the
 * half of the fix that is easy to leave out.
 */
function starHtml(fill: 'full' | 'half' | 'empty', px: number, tint: string): string {
  const svg = (color: string) =>
    `<svg viewBox="0 0 24 24" fill="currentColor" style="display:block;width:${px}px;height:${px}px;max-width:none;color:${color}"><path d="${STAR_PATH}"/></svg>`;
  const base = `<span style="position:absolute;inset:0;line-height:0">${svg('var(--color-rating-empty)')}</span>`;
  const filled = fill === 'empty' ? '' :
    `<span style="position:absolute;inset:0;overflow:hidden;width:${fill === 'half' ? '50%' : '100%'};line-height:0">`
    + svg(tint)
    + '</span>';
  return `<span style="position:relative;display:inline-block;width:${px}px;height:${px}px;flex:0 0 auto">${base}${filled}</span>`;
}

/**
 * The gradient, one star at a time.
 *
 * The site's own `.btn` pair (`--color-rating-from` → `--color-rating-to`) walked across the row in
 * five steps, so a row of stars reads as ONE gradient rather than five identical marks. Five
 * discrete stops rather than a real `linear-gradient`, and the reason is the same one that keeps
 * the half star a clip instead of an SVG gradient: a gradient inside an `fill` needs a
 * document-unique id, and this renders a dozen times on a page of cards. At 13-18px the eye cannot
 * tell five steps from a continuous ramp across ~70px.
 *
 * `color-mix` does the interpolation in the browser, so the two ends stay tokens — swapping the
 * whole site's stars to a gold is those two lines in `tokens.css` and nothing here.
 */
function starTint(index: number, total: number): string {
  const pct = total <= 1 ? 0 : Math.round((index / (total - 1)) * 100);
  return `color-mix(in srgb, var(--color-rating-to) ${pct}%, var(--color-rating-from))`;
}

/** `avg` is the AVERAGE (`reviews.ts#averageRating`), or null for a product nobody has rated —
 *  never a count and never a sum. Taking the number rather than the aggregate is what lets one
 *  review's own score reuse this row unchanged. */
export function starRowHtml(avg: number | null, options: StarRowOptions = {}): string {
  if (avg === null) return '';
  const { px = 15, showValue = false, countLabel, ariaLabel, href } = options;

  const fills = starFills(avg);
  const stars = fills.map((fill, i) => starHtml(fill, px, starTint(i, fills.length))).join('');
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
    + `<span class="inline-flex items-center" style="gap:1px;line-height:0" aria-hidden="true">${stars}</span>`
    + value + count
    + `</${tag}>`;
}

/**
 * The compact form every product CARD uses: ONE star, the average, and the count in brackets.
 *
 * **One star and not five, and that is the difference between a grid and a page** (owner,
 * 2026-08-17). Five stars at 13px repeated down twenty-four cards is a lot of identical ornament
 * competing with the two things a card exists to say — the name and the price — and it costs a
 * third of the card's width to express a number that is right there next to it. A number is also
 * read faster than a shape is counted: `4.5` is exact at a glance, where four-and-a-half stars has
 * to be resolved. It is what Airbnb, Booking and the food-delivery apps do, and they are the ones
 * whose lists are longest.
 *
 * The FIVE-star row stays where it earns its place: the summary on the product page, where there
 * is room and where the shape genuinely says something (4.3 reads as "four and a half" without
 * reading the number), and inside each review row, where the stars ARE the content.
 *
 * Digits only for the count — a card has no room for "12 ביקורות" and brackets need no
 * translation.
 */
export function cardStarRowHtml(agg: RatingAggregate, ariaLabel?: string): string {
  const avg = averageRating(agg);
  if (avg === null) return '';
  const px = 13;
  return `<span class="inline-flex items-center gap-1 align-middle" style="font-size:${px}px"`
    + (ariaLabel ? ` role="img" aria-label="${escapeHtml(ariaLabel)}"` : '')
    + '>'
    // Always whole, and drawn directly rather than through `starHtml` — that one stacks a pale
    // base under a clipped fill so a HALF can be cut out of it, and there is nothing to cut here.
    // This star is a MARK saying "there is a rating"; the number beside it is the measurement, so a
    // half-filled icon would be the same fact drawn twice and worse both times.
    + `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="display:block;width:${px}px;height:${px}px;max-width:none;color:var(--color-rating-to);flex:0 0 auto"><path d="${STAR_PATH}"/></svg>`
    + `<span style="font-size:${px}px;font-weight:700;color:var(--color-text);line-height:1">${escapeHtml(ratingDisplay(avg))}</span>`
    + `<span style="font-size:${px - 1}px;color:var(--color-muted);line-height:1">(${agg.count})</span>`
    + '</span>';
}
