/** Seller pricing tiers — the single source of truth for "what does this seller pay us".
 *
 *  The model (decided 2026-07-21): a tier is a **fixed monthly fee + a per-sale commission**, both
 *  charged additively, where a higher tier buys a LOWER commission. Advertising is billed
 *  separately (pay-per-actual-spend + margin) and is never offset against either number.
 *
 *  ⚠️ THE NUMBERS BELOW ARE PLACEHOLDERS. The tier *shape* is decided; the real fees and
 *  percentages are not (see CURRENT_TASK.md / GO_LIVE_CHECKLIST.md). They live here, in one
 *  table, precisely so settling on the real ones is a single edit and nothing else moves.
 *
 *  Nothing here charges anybody: no money moves anywhere in the app yet (the split-payment
 *  provider isn't wired). Today these figures drive the reporting-only "platform commission /
 *  net profit" lines in the seller + admin performance views. When the processor is wired,
 *  commissionPercentForTier() is what tells it how to split — same function, real consequence.
 *
 *  WHEN the monthly fee starts (decided 2026-07-29, and the reasoning is the decision — moved here
 *  from AI_INSTRUCTIONS.md 2026-07-31 to keep it next to the numbers it governs): **no time-boxed
 *  trial. The fee starts at the seller's FIRST SALE, capped at 2 months from signup.** A card is
 *  taken at signup either way, because the ads Authorize/Capture flow needs one on file.
 *  A 14–30 day trial sat in the spec from 2026-07-21 and was rejected on review: a trial promises
 *  the value lands inside its window, and at launch — few stores, little traffic — it cannot, so
 *  day 14 becomes a scheduled cancellation AND sends the seller away concluding "this doesn't
 *  work". Charging only once the mall has actually sold something for him removes the decision
 *  moment entirely; the 2-month cap is what stops a dead store sitting free forever.
 *  Seller-facing wording is "קודם מוכרים. אחר כך משלמים." — never "התחילו בחינם", which is the
 *  Shopify script and enters a comparison this platform loses (AI_INSTRUCTIONS → Positioning).
 *
 *  Pure/isomorphic: no I/O, no config beyond this file, so it is trivially testable and safe to
 *  import from anywhere (client bundles included).
 */


export type SellerTierId = 'starter' | 'growth' | 'pro' | 'enterprise';

export interface SellerTier {
  id: SellerTierId;
  /** Fixed platform fee, ILS per month, charged regardless of sales. */
  monthlyFee: number;
  /** Percent of each sale taken by the platform on top of the monthly fee. */
  commissionPercent: number;
}

/** Every seller starts here — an account with no tier recorded is treated as Starter, so the
 *  field can stay optional on the Seller record and nothing needs backfilling. */
export const DEFAULT_TIER: SellerTierId = 'starter';

/** Ordered cheapest-first. Higher tier = higher fixed fee, lower commission.
 *
 *  The commission ladder is deliberately SHALLOW (2026-07-27). The monthly fees only span 99→199₪,
 *  so a steep commission drop would make the top tier pay for itself at trivial volume and the
 *  platform would collect ~4% from exactly the sellers who generate the most — commission, not
 *  subscription, is where the revenue actually is at this fee scale.
 *
 *  The constraint each row is tuned against: **upgrade break-evens must rise**. A tier is only
 *  worth offering if there's a revenue band where it beats both neighbours; break-even between two
 *  tiers = (fee difference) / (commission difference). With these numbers:
 *    Starter → Growth      26₪ / 1.00%  ≈  2,600₪ monthly revenue
 *    Growth  → Pro         54₪ / 0.75%  ≈  7,200₪
 *    Pro     → Enterprise  20₪ / 0.25%  ≈  8,000₪
 *  Rising, so each tier owns a real band. If a fee or percent changes, re-check that ordering —
 *  tests/pricing.test.ts asserts it, because getting it backwards silently makes a tier a tier
 *  nobody should ever choose. */
export const SELLER_TIERS: readonly SellerTier[] = [
  { id: 'starter',    monthlyFee: 99,  commissionPercent: 12 },
  { id: 'growth',     monthlyFee: 125, commissionPercent: 11 },
  { id: 'pro',        monthlyFee: 179, commissionPercent: 10.25 },
  { id: 'enterprise', monthlyFee: 199, commissionPercent: 10 },
] as const;

const TIER_BY_ID = new Map<SellerTierId, SellerTier>(SELLER_TIERS.map((t) => [t.id, t]));

/** Resolves a stored tier id to its tier. Unknown/absent falls back to the default rather than
 *  throwing — a bad value in the data must never break a dashboard render. */
export function resolveTier(id: string | undefined | null): SellerTier {
  return TIER_BY_ID.get((id ?? '') as SellerTierId) ?? TIER_BY_ID.get(DEFAULT_TIER)!;
}

/** The per-sale commission percent for a seller's tier — what the split-payment provider will be
 *  told to keep for the platform, and what the reporting views subtract today. */
export function commissionPercentForTier(id: string | undefined | null): number {
  return resolveTier(id).commissionPercent;
}

/** The fixed monthly fee for a seller's tier, ILS. */
export function monthlyFeeForTier(id: string | undefined | null): number {
  return resolveTier(id).monthlyFee;
}

/** The platform's margin on advertising, as a percent ON TOP of what Google/Meta actually charged.
 *
 *  Advertising is a separate component from the subscription+commission pair above (see
 *  AI_INSTRUCTIONS.md → Business model): the platform buys ad space from Google/Meta with its own
 *  card, then bills the seller for the ACTUAL spend plus this disclosed margin. So the platform's
 *  income from a boost campaign is only the margin — the spend itself is a pass-through, never
 *  revenue. ⚠️ PLACEHOLDER, like the tier numbers (CURRENT_TASK.md item 23). */
export const AD_PLATFORM_MARGIN_PERCENT = 15;

/* `adMarginForSpend(spend)` used to live here — `percentOf(spend, AD_PLATFORM_MARGIN_PERCENT)` —
 * and it is deleted rather than kept for a future caller, because it now encodes the WRONG model.
 * When the fee was a markup added ON TOP of the budget it was right. Since 2026-07-30 the fee
 * comes OUT of the budget (ad-metrics.ts#adSpendOfCharge), so the platform's income on a 115₪
 * charge is 15₪ — `charge × 15/115` — and this would have answered 17.25₪, over-booking by 15%.
 * It had no callers, which is the only reason nobody had been misled by it yet.
 *
 * The margin has ONE definition and it is a subtraction, not a percentage: what the seller was
 * charged minus what reached Google/Meta (`ad-scope-label.ts#campaignFeeOf` for one campaign,
 * `platform-revenue.ts` for a date range). That is also why the fee the seller reads on a campaign
 * card and the fee the platform books cannot disagree — they are the same subtraction. */

/** The management-fee percentage a SELLER is told about, which must be the same number the
 *  platform actually books above. It was two: the books took AD_PLATFORM_MARGIN_PERCENT while the
 *  seller's tooltip read `store.config.ts → ads.boostCommissionPercent`, left `null` as "not
 *  decided yet" — so the dashboard showed a vague "a management fee is taken" while 15% was
 *  already being charged in the reporting. A config override still wins (that is what the field is
 *  for), but there is no longer a state where the seller is told less than the platform books. */
export function boostFeePercent(configured?: number | null): number {
  return typeof configured === 'number' && isFinite(configured) && configured >= 0
    ? configured
    : AD_PLATFORM_MARGIN_PERCENT;
}

/** The blended rate a mixed set of sellers actually produced, as a percent of revenue.
 *  The platform-wide view spans sellers on DIFFERENT tiers, so a single headline "commission %"
 *  is only meaningful as revenue-weighted actuals — never as one tier's rate applied to the total.
 *  Returns 0 on zero revenue instead of NaN. */
export function blendedCommissionRate(totalRevenue: number, totalCommission: number): number {
  if (totalRevenue <= 0) return 0;
  return Math.round((totalCommission / totalRevenue) * 10000) / 100;
}
