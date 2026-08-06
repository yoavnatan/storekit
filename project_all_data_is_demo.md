---
name: project_all_data_is_demo
description: "Pre-launch: every row (data/*.json and the live Neon DB) is seeded, no real seller/buyer/order exists yet — but 'demo' means two different things, and the showcase stores are launch PRODUCT, not scratch data. Includes where the seeders' real-vs-demo predicate lives and its one remaining gap"
metadata: 
  node_type: memory
  type: project
  originSessionId: 086d5016-4673-4752-af14-52e5fdd6b7ae
  modified: 2026-08-02T20:39:26.512Z
---

**The platform is pre-launch and has no real users (confirmed by the user, 2026-08-02).** No payment provider is chosen, no shipping integration exists, `GO_LIVE_CHECKLIST.md` is still full of blockers. Every row — `data/*.json` on disk and the populated Neon database alike — was written by a seeder.

**"Demo" is two different things here and conflating them is the mistake to avoid:**

· **The dev catalog** (`npm run seed:demo`, `scripts/seed-demo-data.mjs`) — scratch data, rebuilt by one command, `-- --clean` removes only it. Deleting it needs no ceremony.
· **The three showcase stores** (`showcase-fashion`/`tech`/`home`, `npm run seed:showcase`) — **launch PRODUCT, not scratch.** They exist so the homepage spotlight can page at all (`spotlight.length > 1`), carry `Store.demo`, are always labelled, blocked at checkout server-side, excluded from sitemap/feed/IndexNow, and deliberately not counted toward `isLaunchMode` (`lib/demo-stores.ts`, `lib/launch-mode.ts`). `GO_LIVE_CHECKLIST.md` §6.2 requires seeding them **on the real environment** — they do not appear there by themselves. Fine to drop and re-seed; not fine to leave the environment without them.

Because `launch-mode.ts` keys off the count of REAL stores, any seed or purge changes what the homepage renders — check the page afterwards, not just row counts.

**The transition to real data is already designed for, and this was verified rather than assumed (2026-08-02).** Both seeders scope their purge by a predicate a real row cannot satisfy: the demo one deletes `seller_id IN (SELECT id FROM sellers WHERE email LIKE '%@demo.local')`, the showcase one `demo = true OR seller_id = showcase@dezabin.com`, and `purgeOrdersOfStores` reuses the same predicate on purpose (an order names its store by SLUG, so a cascade would strand demo orders forever). Measured in Neon: 45 stores, 3 flagged `demo`, 42 not. **The one gap: `purge()` in `scripts/lib/seed-db.mjs` executes whatever `WHERE` it is handed** — the safety lives in the two callers, not in the function, so a third caller or an edit to either constant has nothing stopping it. Worth closing before the first real seller exists.

**How I got this wrong, because the shape will recur:** `DB_MIGRATION_PLAN.md` stated that `data/*.json` was gitignored because it "holds names and addresses of real buyers." I trusted that sentence over everything around it and built a backup ceremony around deleting files a seeder rebuilds. The sentence is now corrected. **A document's claim about the DATA deserves the same verification as its claim about the CODE** — and the check is cheap: query the database, or ask.

**When this memory expires:** the day there is a first real seller or buyer. Nothing in the code announces that transition, so re-check it rather than assuming it still holds; at that point the caution becomes real and this file should be rewritten, not trusted.

Related: [[project_db_migration_indexes]], [[project_seeders_db]], [[reference_demo_data_script]], [[reference_go_live_checklist]], [[project_store_readiness_gate]]
