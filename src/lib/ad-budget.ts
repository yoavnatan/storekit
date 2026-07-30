/** What a boost budget may be — the one definition, shared by the server that enforces it, the
 *  form that offers it and the inline editor that changes it later.
 *
 *  Pure (no fs) on purpose: `ad-campaign-input.ts` reads the product/category tables off disk, so
 *  the browser cannot import it, and the rule was being re-typed on the client instead — a `50`
 *  in the create form's `min`, another in the campaign card's inline editor, another in each
 *  route's PATCH. Every one of those is a place the floor can be raised and one copy forgotten,
 *  which is how a seller ends up able to PATCH a campaign below a limit he could not create it at.
 */

/** Lowest budget a boost may carry (₪ per month, or in total for a fixed-duration boost). */
export const MIN_CAMPAIGN_BUDGET = 50;

/** Highest budget a boost may carry. `isFinite` alone lets `1e12` through, and this number is not
 *  decoration: it drives the spend and platform-fee figures on the seller AND admin dashboards
 *  today (ad-metrics.ts#dailyBudget spreads it over the campaign's own period — its fixed
 *  duration, or 30 days for an ongoing one — and multiplies by the days run), and it is what the
 *  Authorize/Capture hold will be taken against once billing is wired (CURRENT_TASK #22). A
 *  ceiling no real Israeli SMB campaign approaches costs nothing and keeps an absurd hand-built
 *  POST out of the reporting. */
export const MAX_CAMPAIGN_BUDGET = 100_000;

/** The ladder the boost form offers, with "another amount" always beside it. A free number field
 *  alone makes the seller invent a figure with nothing to compare against; a ladder answers "what
 *  does a real campaign cost here?" in one glance. Roughly doubling steps, because that is the
 *  size of change that actually shows up in reach — 200→250 does not. Not a validation list: any
 *  amount inside the min/max range is still accepted. */
export const AD_BUDGET_PRESETS: readonly number[] = [200, 500, 1000, 2000];

/** Every budget check, everywhere. Rejects NaN/Infinity as well as out-of-range — a NaN slips
 *  past a bare `>= MIN` comparison, because every comparison against NaN is false. */
export function isValidCampaignBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= MIN_CAMPAIGN_BUDGET && value <= MAX_CAMPAIGN_BUDGET;
}
