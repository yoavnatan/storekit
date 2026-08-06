---
name: project_multitab_concurrency
description: Multi-tab dashboard handling — content-hash revisions (record-rev.ts) + BroadcastChannel notice (tab-sync.ts); an updatedAt stamp was considered and rejected
metadata: 
  node_type: memory
  type: project
  originSessionId: 69bed354-16f7-4279-ac5c-063e5985cdfd
  modified: 2026-07-29T19:21:06.917Z
---

Seller dashboard open in several tabs is handled by TWO deliberately separate mechanisms (built 2026-07-29, סשן ו׳):

- **`src/lib/record-rev.ts`** — the safety half. One content hash PER FIELD the form owns, sent back as `baseRev`; the server does a **three-way merge** (`mergeByFieldRev`): field this tab didn't touch → keep stored; touched only here → take it; both, different values → 409 `conflictFields`. So two tabs editing different fields of the same product BOTH get their way silently, and the seller is interrupted only about the one field genuinely in dispute. `force=1` rides ALONGSIDE `baseRev` (never instead) — it settles only the disputed field, the rest still merges. Absent/short baseline = merge skipped, full overwrite = pre-2026-07-29 behaviour (backward-compatible deploy).

**Why per-field and not one hash for the whole form (the user's correction, and he was right that it should have been obvious):** a single whole-form hash means "save anyway" resends the entire stale form — the seller thinks he is saving one field and silently reverts everything the other tab did. Verified in the browser before the fix: A set price 30→41, B "saved anyway" a stock edit, price went back to 30.
- **`src/scripts/dashboard/tab-sync.ts`** — the ambient half. A receiving tab **live-refreshes when it can, notifies when it can't**: the ACTIVE panel re-runs the refresher it registered via `registerPanelRefresh` (products/orders/messages all do — the same re-fetch their own toolbars use); anything open, expanded or half-typed (`isBusy()`) → `StaleDataBar.astro` instead. Never redraws over work in progress. (User asked for live — "בריאקט זה היה מתרענן לא?"; the answer is React wouldn't either, a second tab is a separate program, so the real choice is redraw-silently vs tell-him. Answer: both, by state.) **Still NOT live: settings / promotions / advertising panels** — they get the notice only.

**Order edit took the cheaper road, on purpose (2026-07-29):** `PATCH /api/seller/orders` is already per-field ("apply if named"), so the modal just snapshots what it opened with and sends only what changed — no revisions, no dialog, nothing to revert. Reach for the full merge only where a form overwrites a record WHOLE. Doing this surfaced a real money bug: `itemDeletes` without a `discount` key wiped an existing discount (`tests/seller-orders-partial.test.ts`).

**Rejected: a record-wide `updatedAt` stamp.** It fires on writes the form doesn't own (a store-wide sale, a bg colour, a feed token vs. the Settings form) — false alarms, and one false alarm teaches the seller to click straight through the real one. The content hash also needs no column, no backfill, and survives the Postgres move unchanged.

**The false-alarm rule this cost a round to learn:** a conflict must only ever mean *someone else* changed it. Every partial save that patches the still-rendered edit row (inline cell edit, per-combo stock, bulk image save) must ALSO carry its new `rev` back onto that row (`syncEditRowRev`), or the seller's own inline edit warns him in a single tab.

`tab-sync.ts` publishes by observing `window.fetch` ONCE rather than calling out from ~20 save sites — a list of call sites to remember to update is a rule that rots. See [[feedback_architecture]], [[project_dashboard_bulk]].
