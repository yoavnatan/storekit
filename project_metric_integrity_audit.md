---
name: project-metric-integrity-audit
description: "DONE 2026-07-29: systematic trace of every seller/admin-visible number + the permanent defences built around it (invariants, fuzz, reconcile, status table, money journal)"
metadata: 
  node_type: memory
  type: project
  originSessionId: cb102e3c-e457-47bb-b2a7-d2df686e6bd6
  modified: 2026-07-30T07:10:46.832Z
---

**Done 2026-07-29** (was: pending). The systematic pass the user asked for — enumerate every seller/admin-visible number, trace each to its source — was run, and the defences below were built so the *class* stays closed rather than the individual bugs.

**Bugs the pass found (all fixed, all were dormant-not-absent):**
- **Three different answers to "which day did this happen on"** — `date-range.ts` used the runtime's local calendar, `dashboard.astro` hand-rolled a copy, `seller-performance.ts` used UTC. Israel is UTC+2/+3, so every sale between local midnight and 02:00/03:00 was filed on the previous day, and one just after midnight on the 1st fell out of "this month". Monthly totals stayed right, which is why nobody would have noticed. Fixed by `src/lib/business-day.ts` — `businessDayISO`/`businessMonthKey` for real instants, `calendarDayISO`/`calendarMonthKey` for synthetic axis cursors. **Mixing those two families up IS the bug** — read that file's header before touching bucketing.
- **Admin Overview couldn't reconcile with the Stores tab** — the headline summed `order.totalAmount` (shipping in, discounts ignored) while the rows summed net subtotals. Also mislabelled: "סה"כ הכנסות פלטפורמה" over a GMV figure, next to a Performance tab where the same words mean commission+subs+ad-margin (~12% of it). Now `getPlatformOverview.gmv` via `orderNetTotal`, relabelled "מחזור מכירות (GMV)", `paidOrders` exposed beside `totalOrders`.
- **Negative revenue** — found by the fuzzer, not by inspection. Seller discount was computed against `subtotal + shipping` but subtracted from `subtotal` alone, so a 100% discount produced `−shipping` revenue for that store and dragged GMV and the commission split below zero. Discount base is now the subtotal only (a seller discounts their own goods, never the platform's shipping rate).
- **No checkout idempotency** — `checkoutRef` was minted per REQUEST, so a lost response, a refresh, or a proxy retry meant a second real charge once a live gateway lands. The disabled button only covers a double-click on one live page.
- **Stock leak** — two "not found" paths in `/api/checkout` returned without restocking earlier items in the same cart.
- **Post-commit rollback** — the checkout catch restocked even when the orders already existed, overselling units that had genuinely sold.
- **Showcase stores counted as real** in the admin "חנויות" headline (the previously-deferred "ask before changing" item). Now real stores only, with `demoStores` shown apart as "(+N הדגמה)". The sibling item, `totalOrders` counting every row, the user explicitly chose to KEEP as-is (2026-07-29) with "(N ששולמו)" beside it.
- **17 more files found by the tree-scanning guard**, none of which anyone had looked at: store/product-pageviews bucketed views by UTC day while revenue used the business day (they share one chart axis and divide into each other for conversion rate), analytics.ts funnel likewise, the CLIENT range picker used the browser's timezone, the dashboard cancel button carried its own copy of the cancellable-status list, plus 13 hand-rolled money roundings.

**The permanent defences (this is the part that matters):**
- `tests/reporting-invariants.test.ts` — properties, not scenarios. Parts sum to whole, commission partitions revenue, two surfaces agree. Runs over fixtures AND over the real `data/orders.json`, so it doubles as a standing data audit.
- `tests/reporting-fuzz.test.ts` — seeded PRNG generating hostile orders (nasty prices, 100% discounts, every status combo, midnight/month-end/DST timestamps). **This is what found the negative-revenue bug.** Seeds capped at 12 for wall-clock, not because more stops finding things.
- `src/lib/reconcile.ts` — computes each headline twice by independent routes and reports drift. Runs live on every admin render, surfaced at the top of the "יומן כספי" tab. A test proves the code was right when written; this proves the data is right now.
- `src/lib/order-status-rules.ts` — one table, a row per status, a column per consequence (countsAsRevenue / holdsStock / cancellableFrom / terminal / notifiesBuyer). A test parses the Order type and fails if a status has no row, so a new status can't inherit whatever the nearest `if` does. `countsAsRevenue` now delegates here.
- `src/lib/money.ts` — every amount rounds here. Interim; the real fix is integer agorot, already specified in `DB_MIGRATION_PLAN.md`.
- `src/lib/money-events.ts` — append-only journal (charge attempts incl. declines, order created, duplicate blocked, status/amount changes).
- `src/lib/checkout-idempotency.ts` — claim→complete/release. ⚠️ single-process `Mutex`; **one instance only until the DB migration**.

**The trap, still true:** payment is stubbed to always approve, so failed/pending orders don't exist in the data yet. Every counter looks fine and proves nothing. Read the counter's code, not its output. See [[feedback_new_state_sweep_consumers]], [[project_order_automation]], [[project_db_migration_indexes]].
