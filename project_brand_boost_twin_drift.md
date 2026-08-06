---
name: project-brand-boost-twin-drift
description: "Boost (AdCampaign) and brand (BrandCampaign) are money twins that keep drifting — fix one, always check the other; twice in one diff 2026-07-30, again 2026-08-02 inside the diff meant to prevent it"
metadata: 
  node_type: memory
  type: project
  originSessionId: 451d3b7f-1edf-4936-9623-ae28b2adf27d
  modified: 2026-07-30T17:44:25.519Z
---

The ad system has **two parallel campaign kinds that both feed reported money figures**, and they are maintained in separate modules that keep falling out of step:

- **boost** — seller-funded, `src/lib/ad-campaigns.ts` (`AdCampaign`)
- **brand** — owner-funded platform-awareness ads, `src/lib/brand-campaigns.ts` (`BrandCampaign`)

Both are aggregated side by side in `src/lib/admin-ads.ts#buildPlatformAdOverview`, and both run through the *same* `runPeriod`/`overlapDays` math in `ad-metrics.ts`. That shared math is exactly what hides the drift: the numbers keep looking plausible.

**Two separate instances found in one review pass (2026-07-30), both in the brand half, both already fixed in the boost half:**

1. `brandSpend`/`impressions`/`clicks`/`conversions` were summed over `brandActive` only, so pausing a campaign mid-month retro-erased spend it had already made. Fixed by the same split the boost half uses: **window figures over ALL campaigns, committed budget over active ones only.**
2. `BrandCampaign` had no `pausedAt` field at all, so `runPeriod` fell back to `updatedAt` — and `updatedAt` moves on every edit. Re-budgeting a paused campaign stretched its run period to the day of that edit and billed the platform for weeks it never ran. Fixed by adding `pausedAt` and stamping/clearing it on the status transition, mirroring `updateCampaign`.

**A third instance, 2026-08-02 — found by `review-diff` inside the very diff that moved BOTH modules to Postgres together specifically to avoid this.** Handed an invalid budget (negative/NaN), `updateBrandCampaign` ignored the field; `updateCampaign` passed it through to the column, where the `CHECK (>= 0)` turns it into a 500 on the dashboard instead of a field the update declined. Same rule, two spellings, one of them written minutes after the other. **Moving the twins in one diff is not enough — the check has to be run against the finished diff too**, which is what caught it.

**How to apply:** any change to campaign status handling, run-period math, or spend aggregation must be checked against BOTH modules before it is called done — grep `brandCampaigns`/`brandActive`/`BrandCampaign` whenever touching the boost side, and vice versa. The two are not yet extracted behind a shared rule (unlike `ad-budget.ts` / `ad-campaign-input.ts`, which were extracted for exactly this reason); until they are, the twin check is manual.

Guards added: `tests/admin-ads.test.ts` asserts a paused campaign's already-accrued spend survives, for **both kinds**; `tests/brand-campaigns.test.ts` and `tests/ad-campaigns-db.test.ts` now cover the `pausedAt` stamp/clear contract and the invalid-budget rule **in the same shape on both sides**, deliberately — so the next divergence is a red test rather than a review finding.

Since 2026-08-02 both are Postgres modules and both budgets are integer agorot named `monthlyBudgetAgorot` ([[project_db_migration_indexes]]).

Same family as [[feedback_new_state_sweep_consumers]] and [[project_metric_integrity_audit]].
