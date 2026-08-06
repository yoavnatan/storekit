---
name: project_boost_billing_model
description: "Boost budget is a CEILING (pay only for actual spend, never prepaid); duration field only picks period vs ongoing, not billing basis"
metadata:
  node_type: memory
  type: project
  originSessionId: 969ba7ce-5768-4a20-8abf-2d6c76d455c1
  modified: 2026-07-21T16:09:05.030Z
---

Seller-funded "boost" campaigns (`AdCampaign`). **Billing model LOCKED with user 2026-07-21: the budget is a CEILING, not a prepayment** — the seller pays only for what actually runs (exactly how Google/Meta postpay billing works), and platform commission is taken only on actual spend. This is the ONLY model consistent with the hard rule "platform never holds seller funds" (prepay-and-hold-ad-budget would be a regulated PSP service). **Cancel:** spend stops immediately; unspent budget was never charged (nothing to refund, nothing stuck). Exact billing cadence (daily/weekly/at-cancel) depends on the unchosen payment provider (SUMIT/Takbull) — the model is fixed, the cadence isn't.

The duration field picks **period vs ongoing** (NOT prepaid-vs-asyougo — both are pay-as-you-go ceilings). **Labels say "תקרה"/ceiling, NOT "תקציב חודשי"** (user flagged "monthly budget" as imprecise 2026-07-21):
- **Fixed duration** = a spending cap for the whole period; label **"תקרת תקציב"**. Duration options are **verbal**: שבוע/שבועיים/חודש (not "7/14/30 ימים"; `durationDays` values still 7/14/30).
- **Ongoing (רציף, `durationDays` absent)** = a monthly cap that renews until stopped; label **"תקרה חודשית"**.

**Gotcha:** the stored field is still named `monthlyBudget` but means "the cap" regardless of mode — don't assume "monthly". `budgetLabel()`/`adBudgetLabelFor()` pick the label per `durationDays` (mirrored in advertising.ts + seller dashboard + admin advertising.astro). Create-form budget label + `#ad-budget-mode-note` swap live on duration `change` (advertising.ts `updateBudgetMode`).

**Who pays whom + billing timing (discussed with user 2026-07-21, NOT built — see CURRENT_TASK items 21-26):** the platform's OWN Google/Meta ad accounts pay Google/Meta (platform card on the platform's accounts); the platform then **rebills the seller** for actual spend + margin. Crucially this is **reselling a service, NOT money-transmission** → it is NOT the regulated-PSP problem that store-sales split-payment avoids, so the platform IS allowed to pay Google/Meta and charge the seller back. Mechanism to avoid holding seller money: **authorize** the ceiling on the seller's card at boost start → **incremental capture** as spend accrues (never a prepaid balance; only a short receivable the auth covers). Billing cadence stated to users = **monthly, in arrears, for actual Google/Meta spend + platform fee, never upfront** (`adBillingTimingNote`, shown in seller boost form + both admin ad surfaces) — mirrors how Google/Meta themselves postpay-bill. Requires SUMIT/Takbull to support auth + **partial/incremental capture** (verify before building — distinct from plain split-payment). An alt model (each seller billed directly via own card on a sub-account under the platform MCC/Business Manager) = zero float but too much seller friction → rejected for zero-touch.

Sellers **top up a live campaign** via an inline "עדכן תקציב" editor on each card (PATCH `monthlyBudget`, refetches; server re-validates ≥50). Copy kept to one sentence per user request ("תקרה — משלמים רק על מה שרץ בפועל…").

Nothing here moves real money yet (mock metrics, no Google/Meta API) — see [[project_automations_in_code]] and AI_INSTRUCTIONS Ads section.
