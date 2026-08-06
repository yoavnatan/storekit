---
name: feedback-new-state-sweep-consumers
description: "adding a new state/status to a shared entity means sweeping EVERY consumer of that field, not just the ones the feature touches"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b157c3e2-50eb-4bc1-a1bf-dc805d6c32c0
  modified: 2026-07-29T19:19:59.705Z
---

When a change adds a new value to a shared entity's state field (a new `shippingStatus`, `paymentStatus`, visibility flag, order/product lifecycle state), the work is not done when the feature's own flows work. Grep every reader of that field across the codebase and decide, explicitly, what the new value means to each one.

**Why:** proven by a real miss. `cancelled` was added as a `shippingStatus` on 2026-07-22 (commit 3685697). That commit correctly handled the consequences it could see — restock, buyer notification, terminal-state guards, two test files — but never opened `seller-performance.ts` or `admin-stats.ts`. Those had summed revenue with `paymentStatus === 'paid'` since 2026-07-15/07-20, which was *correct when written* because cancellation didn't exist yet. A cancellation deliberately leaves `paymentStatus:'paid'` (the charge really happened) and only moves `shippingStatus`, so from 07-22 onward every cancelled order stayed inside the seller's Performance revenue AND the admin's GMV/commission split — reporting money whose stock had already gone back on the shelf. It survived seven sessions and was found only on 2026-07-29 because the user asked for a data-integrity audit, not by any process. Nothing failed: no error, no test, and `data/orders.json` happened to hold zero paid+cancelled orders, so no dashboard ever displayed a wrong number. It was waiting for the first real cancellation.

**How to apply:** two habits. (1) On any new state value, `grep` the field name repo-wide and check each hit — the dangerous consumers are the ones the feature never touches. (2) When a business rule appears as the same one-line condition in two or more modules, that duplication IS the bug waiting to happen — give it a name in one place (`countsAsRevenue()` in `orders.ts` is the fix here) so the next new state has a single site to update, plus a guard test that greps for the old inline condition coming back. See [[feedback_fix_security_dont_report]] for the same instinct applied to a security gap: fix the whole class, then add the guard.
