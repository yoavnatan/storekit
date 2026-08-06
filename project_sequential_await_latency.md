---
name: project_sequential_await_latency
description: "Awaits that were free as JSON file reads are now serial network round trips — independent reads on a click path must be issued together, and loading cues tuned for file speed became visible flicker"
metadata: 
  node_type: memory
  type: project
  originSessionId: a8715dc9-8c9d-4552-a1b1-49c667fda5e3
  modified: 2026-08-03T13:04:24.747Z
---

**The class, found 2026-08-03 when the owner reported store category chips "greying out for a second".**
Two distinct defects, both created by the DB migration without a line of that code changing.

1. **Sequential `await`s cost nothing as file reads and are round trips as queries.** A handful of
   `const a = await x(); const b = await y();` where `y` does not need `a` is a natural shape when
   each is a local file read. Against Neon each one is a full round trip in series. Measured on
   `/api/store-products`: **266ms of pure waiting, 134ms of it queue rather than work** — issued
   together with `Promise.all` it halves. **It only works because the app uses a pool** — a single
   `pg.Client` serialises queries on its one connection, and a benchmark written with `Client`
   will report "parallel is no faster" and be wrong (this happened; the deprecation warning about
   concurrent `client.query()` is the tell).
   **Grep the click paths and page frontmatter for this shape** — `[storeSlug]/index.astro` still
   has it (isFavorited / allProducts / storeCategories / demoIndex are all independent of each other).

2. **A loading cue calibrated to file speed becomes flicker at network speed.** The grid dim was
   applied the instant the fetch started — invisible when the answer took a millisecond, a grey
   flash on every click once it took 300. Fix: **arm the cue on a timer, cancel it if the answer
   beats it.** Below the threshold the swap is instant and there is no cue at all.

**Choosing that threshold — do not tune it to hide a symptom.** ~100ms is where a response stops
feeling instant; ~1s is where a wait genuinely needs explaining. In between is a judgement call, so
pick the upper half and say why. Here 450ms, because measurement showed a click answers in
280-350ms **from a laptop 66ms from Frankfurt** — anything inside that band fires on a quarter of
dev clicks and never in production, where the app server shares the DB's region. **A dev machine's
distance to the database is not the product**; measure both before picking a number.

Measure the BUILT server, not just `astro dev` — here they were identical, which is itself the
finding: the cost was network, not framework.

Related: [[feedback_noop_interactions_invisible]] · [[project_db_migration_indexes]] ·
[[project_admin_dashboard_render_cost]] (measure first) · [[feedback_live_visual_debugging]]
