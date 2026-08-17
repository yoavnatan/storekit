/**
 * The id of the reviews section on a product page — one constant, because three unrelated things
 * link at it and a typo in any of them is a silent dead link.
 *
 * The product page renders it, the rating summary under the title scrolls to it, and the Google
 * review feed publishes `<review_url>` pointing at it. Its own tiny module rather than a field on
 * `reviews.ts` so a `.astro` component and a feed builder can both import it without dragging the
 * arithmetic (or, worse, the database layer) along.
 */
export const REVIEWS_SECTION_ANCHOR = 'reviews';
