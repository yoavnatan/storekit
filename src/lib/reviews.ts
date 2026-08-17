/**
 * The arithmetic and the wording rules of a product review. No database, no request — so the
 * product page, the star component, the JSON-LD, the Google feed and the tests all read ONE
 * definition of "what is 4.5 stars".
 *
 * Everything that touches the database is next door in `product-reviews.ts`; who is ALLOWED to
 * write one is in `review-eligibility.ts`. Three files because they answer three different
 * questions and only this one has to be callable from a component.
 */

/** The scale, stated once. The DB `CHECK (rating BETWEEN 1 AND 5)` is the same fact in SQL. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;

/**
 * How long a review may be.
 *
 * Not a UX preference: this is a free-text field a stranger can publish on a seller's product page
 * and — through the reviews feed — on Google. The cap is what stops one submission from being a
 * page of keyword spam, and it is enforced at the API rather than only in the textarea.
 */
export const REVIEW_BODY_MAX = 1500;

/** Text is OPTIONAL — a rating on its own is a complete review, and the friction of demanding a
 *  paragraph is what makes review systems empty. Google's feed disagrees (it requires `content`),
 *  so a rating-only review is published on the page and skipped by the feed; `review-feed.ts` says
 *  so at the filter. */
export const REVIEW_BODY_MIN = 0;

export interface RatingAggregate {
  /** Published reviews. */
  count: number;
  /** Sum of their ratings — see the migration for why the sum and not the average is stored. */
  sum: number;
}

/**
 * The average, or null when nothing has been rated.
 *
 * **Null, never 0.** A product with no reviews does not have a rating of zero — it has no rating,
 * and the difference is the whole of whether the stars render at all. Returning 0 here is how a
 * brand-new product ends up displaying one empty star and a `ratingValue: 0` in its structured
 * data, which Google reads as a real (terrible) score.
 */
export function averageRating(agg: RatingAggregate): number | null {
  if (agg.count <= 0) return null;
  return agg.sum / agg.count;
}

/** The average as a shopper reads it: one decimal, e.g. `4.5`. Also what the JSON-LD publishes —
 *  the two must never disagree, which is a Google structured-data mismatch and not a nicety. */
export function ratingDisplay(avg: number): string {
  return (Math.round(avg * 10) / 10).toFixed(1);
}

export type StarFill = 'full' | 'half' | 'empty';

/**
 * The five stars, as fills — the half-star rule, in one place.
 *
 * Rounded to the nearest HALF, not floored: 4.4 is four and a half stars and 4.2 is four, because
 * the mark a shopper reads should be the closest true one. Flooring makes every product look worse
 * than it is by up to a full star, and rounding UP (`ceil`) makes 4.1 read as 4.5, which is the
 * direction that misleads.
 *
 * The number beside the stars (`ratingDisplay`) stays the real average, so the two together are
 * honest even where the rounding is visible.
 */
export function starFills(avg: number): StarFill[] {
  const halves = Math.round(Math.max(0, Math.min(RATING_MAX, avg)) * 2);
  return Array.from({ length: RATING_MAX }, (_, i) => {
    const filledHalves = Math.max(0, Math.min(2, halves - i * 2));
    return filledHalves === 2 ? 'full' : filledHalves === 1 ? 'half' : 'empty';
  });
}

/** A rating that arrived from a request — anything else is a refusal, never a clamp. Clamping
 *  would turn a broken client into a silent 5-star. */
export function isValidRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= RATING_MIN && value <= RATING_MAX;
}

/**
 * What gets PUBLISHED as the author's name.
 *
 * A review is public and permanent; the checkout name is not something a buyer typed expecting to
 * see it under a paragraph about a product. So the surname is reduced to an initial — "יואב נתן"
 * becomes "יואב נ׳", "John Smith" becomes "John S." — which is enough for a review to read as a
 * person's and not enough to identify one.
 *
 * A one-word name is left alone (there is nothing to shorten), and an empty one stays empty: the
 * renderer supplies the localised "קונה" / "Buyer", because the language a review is READ in is not
 * the language it was written in and baking one into the row would freeze it forever.
 *
 * Called once, at write time, and the result is stored — see the migration.
 */
export function reviewerDisplayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0]!;
  if (parts.length === 1) return first;
  const initial = [...parts[parts.length - 1]!][0] ?? '';
  if (!initial) return first;
  // Hebrew takes the geresh, Latin the period — the same abbreviation mark in each script.
  const mark = /[֐-׿]/.test(initial) ? '׳' : '.';
  return `${first} ${initial}${mark}`;
}

/** Trim + collapse the runaway blank lines a textarea produces, then cap. Never rejects on length —
 *  the API does that, so a caller cannot silently publish a truncated half-sentence. */
export function normalizeReviewBody(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The letter in the reviewer's circle.
 *
 * The FIRST character, taken with a code-point-aware split so an emoji or a surrogate pair does not
 * come back as half of itself — the same care `reviewerDisplayName` takes over the surname's
 * initial. Upper-cased for Latin; Hebrew has no case, so the call is simply a no-op there.
 *
 * A name that reduces to nothing (a reviewer with none, and the localised fallback missing too)
 * gets `?` rather than an empty circle: a blank coloured disc reads as a rendering failure.
 */
export function reviewerInitial(name: string): string {
  const first = [...name.trim()][0] ?? '';
  return first ? first.toUpperCase() : '?';
}

/**
 * The distribution bar on the product page: how many reviews gave each score, 5 down to 1.
 *
 * Always five entries, zeros included — a histogram that hides its empty rows re-scales itself
 * every time a review lands and stops being comparable between two products.
 *
 * Takes the COUNTS, not the ratings: the database groups them (`getRatingCountsForProduct`), so a
 * product with ten thousand reviews still hands this five rows. A score outside the scale is
 * ignored rather than trusted — the DB `CHECK` makes it impossible, and a bar drawn from one would
 * be silently wrong instead of absent.
 */
export function ratingHistogram(counts: readonly { rating: number; count: number }[]): { rating: number; count: number }[] {
  const byRating = new Map(counts.map((c) => [c.rating, c.count]));
  return Array.from({ length: RATING_MAX }, (_, i) => {
    const rating = RATING_MAX - i;
    return { rating, count: byRating.get(rating) ?? 0 };
  });
}
