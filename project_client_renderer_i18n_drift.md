---
name: project_client_renderer_i18n_drift
description: "A client-side rebuilder of server-rendered markup drifts out of i18n — the seller dashboard's order cards were English shell + Hebrew cards"
metadata: 
  node_type: memory
  type: project
  originSessionId: ecaaaace-ece2-4ee7-88c0-376992e242de
  modified: 2026-07-31T13:57:05.931Z
---

When a surface has BOTH an SSR renderer and a client rebuild (sort/filter/paginate replacing the list), the client copy is where hardcoded strings survive: it is written as a template literal, nothing type-checks its text, and the language toggle is the only thing that reveals it. Found 2026-07-31 from "switching to English shows a Hebrew dashboard": `src/scripts/dashboard/orders.ts` had ~30 Hebrew literals (card body, cancel-confirm, new-order toast, the whole edit-order modal) and passed a pinned `'he'` to `orderAgeChipHtml`. The SSR card in `seller/dashboard.astro` had four of its own.

**Why:** the `??  'Hebrew'` fallback pattern hides it — the key exists, so the code *looks* translated, and the fallback only ever fires in the wrong language.

**How to apply:** the client module reads its strings through one `tt(key, n?)` accessor (no per-call-site fallback), and takes the page language from `document.documentElement.lang`, never a constant. `tests/orders-i18n.test.ts` fails on any Hebrew literal outside a comment in that file and on a key either dictionary is missing — copy that test when a new tab gets a client rebuilder. Still Hebrew-only by design: the whole admin surface (`AdminOrdersPanel.astro` and siblings). Related: [[project_order_card_layout]], [[feedback_language]].
