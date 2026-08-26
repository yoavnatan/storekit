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
 *  WHEN the monthly fee starts: **when the seller starts the subscription, which is the same act as
 *  putting his shop on the site.** Nothing before that, and no free window at all
 *  (`lib/store-publication.ts`, `lib/seller-subscription.ts`). And it starts AFTER PayMe approve the
 *  business, not before — paying used to come first and left a seller charged through a seven-day
 *  wait for a shop that was not up (owner, 2026-08-24). The order is in `store-publication.ts`.
 *
 *  WHOSE the plan is: **a STORE's, since 2026-08-24** (owner: *"כל חנות צריכה לעלות כסף בנפרד"*).
 *  A tier is one bargain — a higher fee buys a lower commission — so the fee and the rate move
 *  together and both belong to the shop. `lib/store-plan.ts` owns that, including the rule that a
 *  seller still has ONE standing order whose amount is the sum of the shops he has on the site.
 *  `sellers.tier` is the old single-plan column; nothing reads it any more.
 *
 *  AND NOT A CONFIG NUMBER: `store.config.ts` deliberately has no `commissionPercent`. A rate in a
 *  config is a rate that applies to everybody, which is the one thing a tier ladder cannot be —
 *  and it is the shape this file replaced.
 *
 *  ⚠️ **The old answer — "the fee starts at the seller's FIRST SALE, capped at 2 months from
 *  signup" — is WITHDRAWN, and it must not come back.** It was decided on 2026-07-29 against a
 *  14–30 day trial, for reasons that were sound at the time: a trial promises value inside a fixed
 *  window, and at cold start there are no sales by day 14, so it manufactures a scheduled
 *  cancellation. What killed it is not a change of mind but the decision of 2026-08-23 — a seller
 *  builds a whole shop with no card, and **selling is one of the things blocked until he pays**.
 *  A rule that starts billing at the first sale can therefore never fire: there is no sale before
 *  the first charge, by construction. It survived only as prose, here and in one line of the
 *  pricing page, and it promised a seller something this platform cannot do (owner, 2026-08-24:
 *  *"ובטח שלא מתחילים לגבות ממכירה ראשונה כי זה לא נכון"*).
 *
 *  A card is still taken when a campaign is created, because the ads Authorize/Capture flow needs
 *  one on file — that is a different card and a different moment from the subscription.
 *  Seller-facing wording never says "התחילו בחינם": that is the Shopify script and enters a
 *  comparison this platform loses (AI_INSTRUCTIONS → Positioning).
 *
 *  Pure/isomorphic: no I/O, no config beyond this file, so it is trivially testable and safe to
 *  import from anywhere (client bundles included).
 */


export type SellerTierId = 'starter' | 'growth' | 'pro' | 'enterprise';

/**
 * ── EVERY NUMBER IN THIS FILE IS **BEFORE VAT** (owner, 2026-08-18) ──
 *
 * This had never been written down anywhere, and it is worth 18% of the platform's whole revenue —
 * on the 99₪ fee and on the commission alike — so it is stated here rather than left to be assumed
 * by whoever builds the pricing screen.
 *
 * **It is the opposite convention to the rest of the app, and both are right.** `lib/vat.ts` says
 * prices here are VAT-INCLUSIVE, because those are CONSUMER prices: an Israeli shopper is quoted
 * what they will pay, and a storefront price that grew by 18% at checkout is also a Merchant Center
 * price mismatch. What this file holds is different — a B2B fee charged to a registered business —
 * and the convention there is `+ מע״מ`, for the reason the owner gave when he settled it: **the
 * seller reclaims that VAT, so it costs him nothing and it is ours to keep.** It is also exactly
 * how our own suppliers quote us (PayMe's schedule: *"כלל המחירים אינם כוללים מע״מ"*).
 *
 * **So every seller-facing surface must say `+ מע״מ` beside these numbers.** A seller who reads
 * "99₪ לחודש" and is then invoiced 116.82₪ has been surprised by us on the one screen where trust
 * is being established; and if we instead absorb it to avoid that, the fee was silently 84₪ all
 * along.
 *
 * ── The seller who CANNOT reclaim it, and the amendment of 2026-08-26 ──
 * *"אבל גם לקוח שלי יכול להיות עוסק פטור, זה העניין."* And he is right: an **עוסק פטור** is not
 * registered for VAT, so he deducts no input tax — the 18% is a real 18% for him, on exactly the
 * smallest seller this platform is built for. The convention did not change (owner, same day:
 * *"לא, המחירים לא כוללים מע״מ"*); what changed is what he is SHOWN. A seller who cannot reclaim
 * is given the gross alongside the net — *"שלעוסק פטור יהיה כתוב גם הסה״כ… בצורה עדינה"* — and a
 * seller who can is not, because for him it is noise. `vat.ts#chargesVat` is the test, and it is
 * the same one that decides whether HIS invoice to a buyer carries VAT.
 *
 * ── And what is actually CHARGED had to catch up ──
 * Until 2026-08-26 the standing order was created at the bare fee and `market_fee` was sent as the
 * bare percent, so a screen saying "99 ₪ + מע״מ" sat over a card debited 99 ₪ — the promise and the
 * charge were two different numbers, in our favour on the screen and against us in the bank. The
 * two helpers below are the single definition of "what this fee really costs", and every boundary
 * that hands a figure to the processor goes through one of them.
 */
import { platformVatPercent } from './vat.js';

/** A fee quoted in this file, as the seller is actually billed for it.
 *
 *  The rate is the PLATFORM's (`vat.ts#platformVatPercent`) and never the seller's: what he is
 *  charged is decided by what WE are, and an עוסק פטור platform charges none at all. It is a
 *  parameter so the arithmetic stays pure and testable at any rate. */
export function feeWithVatAgorot(agorot: number, vatPercent: number = platformVatPercent()): number {
  if (!Number.isFinite(agorot) || agorot <= 0) return 0;
  return Math.round(agorot * (1 + vatPercent / 100));
}

/**
 * A commission RATE, as the percentage really deducted from a sale.
 *
 * The commission is taken inside the transaction as PayMe's `market_fee`, which is a percentage —
 * so charging VAT on it means sending a bigger percentage, not adding a line. 12% becomes 14.16%.
 *
 * **Not rounded to two places here.** `market_fee` is sent as a JSON number and PayMe apply it to
 * the sale price; rounding the rate would shift every commission by a fraction of an agora in one
 * direction, and `commission-check.ts` compares our figure against theirs at a one-agora tolerance.
 * Both sides now compute from the same rate, so the only rounding left is the one on the amount.
 */
export function feeWithVatPercent(percent: number, vatPercent: number = platformVatPercent()): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return percent * (1 + vatPercent / 100);
}
export interface SellerTier {
  id: SellerTierId;
  /** Fixed platform fee, ILS per month, BEFORE VAT, charged regardless of sales. */
  monthlyFee: number;
  /** Percent of each sale taken by the platform on top of the monthly fee. The percentage applies
   *  to the sale as the buyer paid it; VAT is added to the resulting fee, not contained in it. */
  commissionPercent: number;
}

/** Every seller starts here — an account with no tier recorded is treated as Starter, so the
 *  field can stay optional on the Seller record and nothing needs backfilling. */
export const DEFAULT_TIER: SellerTierId = 'starter';

/**
 * What the SELLER pays PayMe once, to open his clearing account — ₪99, before VAT
 * (`GO_LIVE_CHECKLIST.md` §3.1.0, appendix ב׳).
 *
 * ── It is his, and we stopped covering it (owner, 2026-08-24) ──
 * A ruling on 2026-08-21 had the platform absorb it out of his first subscription payments, so he
 * *"לא ירגיש"* it. The owner reversed that on the arithmetic: month one on Starter was ₪99 in
 * against ₪65 terminal plus ₪99 setup, a ₪65 loss on a seller who has not sold anything yet, and
 * *"אני לא מוכן שזה יתגלגל אליי"* — a supplier's fee is not ours to carry.
 *
 * **The ₪65/month terminal is NOT the same kind of number and stays ours.** PayMe bill it to the
 * partner wallet, so it cannot be passed to a seller at all; it is priced into the subscription,
 * which is why Starter leaves ₪34 before commission.
 *
 * ── Which is why the page no longer says "אין דמי הקמה" ──
 * It said exactly that until today, and with this fee in the flow it would be the VAT mistake in a
 * second costume: a seller who reads "no setup fee" and is then charged ₪99 has been surprised by
 * us on the screen where trust is established. Every surface that mentions starting to pay names
 * it instead — the plans page, the help centre and the subscription card all read this constant.
 */
export const SELLER_SETUP_FEE = 99;

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

/**
 * The platform's cut of a revenue figure held in integer AGOROT.
 *
 * Its own function because `money.ts#percentOf` is the ILS version — it rounds to two decimals,
 * which on an agorot input leaves a fraction of an agora rather than removing one. This rounds to
 * the agora, once, at the end. Written here rather than at each reporting surface so the seller's
 * "platform commission" line, the admin's income line and a seller's accrued balance
 * (lib/seller-balance.ts) are arithmetically the same number and not three roundings of it.
 */
export function commissionOnAgorot(revenueAgorot: number, commissionPercent: number): number {
  if (!Number.isFinite(revenueAgorot) || !Number.isFinite(commissionPercent)) return 0;
  return Math.round((revenueAgorot * commissionPercent) / 100);
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
