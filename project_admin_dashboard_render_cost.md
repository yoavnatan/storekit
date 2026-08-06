---
name: project-admin-dashboard-render-cost
description: "Every admin panel swap re-renders all 11 panels; the 600ms of it was Intl-per-call, fixed 2026-07-31 — the remaining structural waste is deliberate"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8a111b55-cd36-406b-8033-8b7c87eba35e
  modified: 2026-07-31T10:55:52.089Z
---

`/admin` computes and renders **all 11 panels on every request**, and `swapPanel`
(admin-nav.ts) fetches that whole page for each search keystroke / sort / filter chip
and throws ~10/11 of it away. Measured on a real build 2026-07-31: a store-state filter
click took **~700ms** server-side.

Two Intl-per-call traps were the whole 700ms, both now fixed:
- `toLocaleDateString(locale, opts)` **constructs a new Intl.DateTimeFormat every call**
  (~0.2ms). `seller-performance.ts`'s axis labels did this ~31× per store × 45 stores.
- `getDailyPageViews` re-parsed the 2 MB `store-pageviews.json` **once per store**.
- Smaller: `businessDayISO` ran `formatToParts` per order per store (57ms → 2ms memoised).

After: **~80ms, 64KB gzipped.** Guard test: `tests/store-pageviews-cache.test.ts`.

**Why:** the user's instinct ("it's doing some ineffective operation there") was right,
but the ineffective operation was Intl construction in a loop, not the panel-swap
architecture — which is why measuring first mattered.

**How to apply:** the render-all-11-panels waste is still there and was left alone on
purpose (80ms/64KB is fine). If it ever needs fixing, the shape is a `?partial=<panel>`
mode on `/admin` that guards each tab's frontmatter block and renders one panel without
`BaseLayout` — not worth its regression risk today. Before optimising anything here,
bench with a throwaway vitest file over the real `data/*.json` and confirm end-to-end
against `astro build` + `dist` on a spare port; see [[feedback_dev_server]].
