# The SaaS pivot — the shape a revived Dezabin would take

**Status: a shape chosen, not a project restarted.** The owner asked on 2026-09-07 what could be
done about the two things that killed the project, was given the fork as a card, and chose the SaaS
shape. Development is still stopped (memory `project_dezabin_stopped_job_search`); nothing here is a
task list until he says the project is running again.

## The two blockers were one blocker

He stopped for two stated reasons: PayMe wanted **8,000₪ setup** for a marketplace-structured
clearing agreement, and the shipping/returns integration had grown into a project of its own.

Both are consequences of the marketplace shape, not of payments or logistics as such.

- The 8,000₪ buys **the split at the moment of payment** — `multi-capture` against N seller
  accounts from one card entry (`project_split_model_payme`). An ordinary shop that clears into a
  single account does not need a marketplace programme and is not quoted a marketplace price.
- The shipping work was heavy because of one requirement and one only: **a different pickup address
  on every parcel**, collected by the courier from the seller's door
  (`project_shipping_provider_direct`). That is what forced three parallel carrier negotiations, a
  tariff that varies by pickup locality, and a returns/claims policy we had to author.

Remove the marketplace shape and both disappear — along with the reason he actually gave for
stopping, which was neither of them: **a two-sided marketplace is not sustainable for a single
operator** (vendors, VAT, seller complaints, permanent operational liability).

## What the SaaS shape is

Each seller runs **their own shop**: their own clearing account, their own courier, their own
returns policy, their own invoices. Dezabin sells the shop — the storefront, the catalogue, the
dashboard, the SEO surface and the ad plumbing. Money for the *goods* never comes near us, which is
the same regulatory conclusion the split model reached, arrived at more cheaply.

What we clear ourselves is **one thing**: the seller's monthly bill, on one ordinary terminal of
ours. That is a standing order against a saved card — a normal product at every Israeli provider,
not a marketplace agreement.

## What this costs — say it before building anything

1. **The per-sale commission stops being automatic.** Today `lib/pricing.ts` takes 10–12% inside the
   transaction as PayMe's `market_fee`. In this shape the sale never touches us, so the commission
   becomes a **monthly charge computed from recorded orders** — which means it can fail to collect,
   and the enforcement is suspending the shop. The alternative is a subscription-only price with no
   commission at all. **Open — owner's call** (see below).
2. **The seller needs their own clearing account.** That is the new barrier replacing the 8,000₪, and
   it collides with `feedback_seller_form_burden` / `project_zero_touch_selfservice`. A seller who
   already sells anywhere has one; a seller starting from zero does not, and needs either an
   in-wizard signup link to a provider or a no-online-payment mode (order placed, paid on delivery
   or by transfer) so the shop is usable on day one.
3. **Shipping becomes the seller's**, which explicitly reopens the 2026-07-27 platform-only decision
   (`project_shipping_model`). The seller sets the price and ships; we hold a tracking number and a
   carrier name as fields. This is the single largest reduction in scope in the whole pivot.

## What changes in code — measured, not estimated

- `src/lib/payment.ts` — 158 lines, still a **mock seam**; no PayMe call was ever written against
  it. It stops being a goods-payment gateway and becomes the *subscription* gateway. The checkout
  charges through the seller's provider instead.
- `src/lib/shipping.ts` — 138 lines, rates are placeholders, 13 files consume it. `SHIPPING_RATES`
  becomes per-store data instead of a platform constant; `offersSelfPickup` and
  `availableDeliveryMethods` survive unchanged in meaning.
- **The payouts layer inverts rather than dies.** `PayoutsPanel`, `AdminStatementPanel`,
  `AdminReconciliationCard`, `AdminMoneyLogPanel` and `ReportsPanel` today answer "how much do we owe
  this seller". The same data answers "how much does this seller owe us" — direction flipped, the
  screens kept. `ClearingDetailsForm` changes meaning entirely: it stops collecting bank details for
  a payout and starts holding the seller's own provider credentials.
- Untouched: storefront, catalogue, cart, product/variant model, dashboard shell, SEO, sitemap,
  feeds, ads, domains, accessibility, privacy.

## What is NOT verified here

- **Which provider gives us a standing order on a saved card, at what monthly cost.** Grow, Cardcom,
  PayPlus and Tranzila were all ruled out earlier *only* for lacking merchant-creation and split —
  the criterion that no longer applies. None has been re-read against its official docs for
  recurring billing. Do that before naming one (`feedback_verify_before_recommending`).
- Whether a seller's own provider can be embedded in our checkout by iFrame per store, which decides
  whether checkout stays on our domain.
- What multi-store checkout means when each store clears separately — probably one cart per store,
  which is where `project_multistore_checkout_plan` already landed.

Related memories: `project_split_model_payme`, `project_shipping_model`,
`project_shipping_provider_direct`, `project_business_model_pricing`,
`project_launch_three_conditions`, `project_dezabin_stopped_job_search`.
