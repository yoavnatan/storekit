---
name: project-business-model-pricing
description: "Pricing tiers: model DECIDED 2026-07-21, numbers + code landed 2026-07-27 in src/lib/pricing.ts; commission ladder deliberately shallow, fees final / percentages placeholder"
metadata:
  node_type: memory
  type: project
  originSessionId: ace550da-e7e6-4945-a746-c1bb0e5af92c
  modified: 2026-07-27T17:42:53.086Z
---

**Model DECIDED 2026-07-21; BUILT 2026-07-27.** Supersedes the old "no fixed fees / success-based only" line — there ARE fixed monthly fees.

**The model — clean tiers** (chosen over an offset/`max(sub,commission)` scheme because the user's top priority is that pricing be CLEAR to the seller; the tier table is the Shopify/Wix mental model sellers already know and fits zero-touch self-service): each tier = fixed monthly fee + per-sale commission %, higher tier lowers the commission, both charged **additively, not offset**.

**In code:** `src/lib/pricing.ts` is the SINGLE source. `store.config.ts` deliberately has no `commissionPercent` — a global number contradicts per-seller tiers. Commission is per **account** (`Seller.tier?`, optional → defaults to Starter, so nothing needs backfilling), never per store: the subscription belongs to the registered business.

Current table — **monthly fees are the user's own numbers (final); percentages still placeholder**:
Starter 99₪/12% · Growth 125₪/11% · Pro 179₪/10.25% · Enterprise 199₪/10%.
(99₪ is right for a full store system; cheaper "feels cheap"/unserious — user rejected a near-zero Starter.)

**Why the commission ladder is shallow — decided 2026-07-27 after the user asked "wouldn't 350₪ for a 4% tier be better?":** the fees only span 99→199₪, so a steep drop hands the biggest sellers a rate the flat fee can never offset. A 4% tier is revenue-neutral vs Starter only at a ~4,000₪/mo subscription; at 350₪ it loses ~15,700₪/mo on a seller doing 200K₪ GMV, because the fee is flat while commission scales. If most platform revenue is meant to come from commission, the floor stays double-digit. A real 4% deal is a one-off retention arrangement, not a published tier.

**Invariant to preserve on ANY number change:** upgrade break-evens (fee delta ÷ commission delta) must RISE across tiers, else a middle tier is strictly dominated and nobody should ever pick it. The first attempt (12/9/6/4) failed this — Pro was dominated. Guarded by `tests/pricing.test.ts`.

**Ads stay a completely separate component**, never offset against subscription/commission. Pay for actual spend via **Authorize/Capture**: reserve the budget upfront (auth ≠ holding funds, consistent with never-hold-funds), capture only what was used + the disclosed platform ad margin, release the rest. See [[project_boost_billing_model]].

**No trial — DECIDED 2026-07-29 (supersedes the 14–30d free trial, which was never the user's choice; it was written into the spec on 2026-07-21 unattributed and he caught it).** Instead: the monthly fee starts at the seller's FIRST SALE, capped at 2 months from signup. Card still taken at signup (the ads auth/capture needs it on file).

**Why, and where the user's own reasoning was corrected:** he worried a trial makes people not continue. That mechanism is wrong — a trial mostly *reveals* churn early, and losing a bad-fit seller cheaply is a win. The real problem is specific to this platform: a trial promises value inside a fixed window, and at cold start (few stores, little traffic) there will be no sales by day 14. So the trial manufactures a scheduled cancellation AND sends the seller away concluding "this doesn't work" — far more expensive than never signing him. Charging only after the mall has actually sold for him deletes the decision moment; the 2-month cap stops a dead store sitting free indefinitely. Cost accepted: revenue is deferred and hard to forecast.

**Seller-facing wording (user asked for it, 2026-07-29): "קודם מוכרים. אחר כך משלמים."** + "דמי המנוי נכנסים לתוקף במכירה הראשונה שלכם בקניון, ולא יאוחר מחודשיים." Never "התחילו בחינם" — that's the Shopify script and enters a comparison this platform loses (see [[project_business_model_pricing]]'s positioning note in AI_INSTRUCTIONS).

**Still unbuilt:** NO UI anywhere changes a tier — not admin, not seller. Deliberately waiting on the payment provider, since tier changes are tied to subscription billing + card-at-signup. Also unbuilt: auto-recommending the cheapest tier for a seller's actual volume ("Pro would save you X₪") — nice-to-have, not committed. Exact percentages + trial length still to validate with real sellers + accountant. Cold-start remains the real risk ([[project_existential_doubt_resolved]]).
