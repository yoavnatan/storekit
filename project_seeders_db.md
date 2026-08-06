---
name: project_seeders_db
description: "Both seed scripts write ONLY to Postgres (npm run seed:showcase / seed:demo, DATABASE_URL required). A seeder NAMES a purge scope and never writes a WHERE — the gate that enforces that lives in seed-db.mjs, not in the callers (2026-08-03)"
metadata:
  node_type: memory
  type: project
---

**Fixed 2026-08-02, in the session `store-products` migrated.** Both seeders had silently done nothing since `sellers`/`stores` moved to Postgres — they wrote four `data/*.json` files nobody reads any more, so they ran to completion, printed a success line, and created nothing. No error, no red test. That is what this memory used to warn about; it is now history, kept because the SHAPE recurs: **a writer pointed at a store nobody reads reports success forever.**

**How they work now:**
- `npm run seed:showcase` / `npm run seed:demo` (`-- --clean` to remove). **`DATABASE_URL` is required** — without it they exit with instructions instead of succeeding quietly.
- `scripts/lib/seed-db.mjs` is the shared DB half: `openSeedClient` / `purge` / `writeCatalog`. **Purge and write are ONE transaction** — both seeders fetch photos from the network first, so a purge that committed on its own would delete the showcase stores and put nothing back when the run then fails.
- **Purging a seeded store does NOT take its orders with it, and that needed its own function** (`purgeOrdersOfStores`, called BEFORE the store delete, while the slug still exists to recognise them by). An order names its store by **slug, not foreign key** — deliberately, so a deleted store cannot take financial history with it (§4) — so `DELETE FROM stores` cascades to products and categories and strands the orders. Correct in production; a leak in a seeder, where every re-run would orphan another set that no page, no revenue figure and no `--clean` could ever reach.

**What made it fixable to verify:** `tests/seed-db.test.ts` asserts a seeded store is visible **through the app's own readers** (`getStoreBySlug`, `getVisibleProductsByStoreId`). That single assertion is what was missing for three modules; a test of the DummyJSON fetching would not have caught anything.

`seed-showcase-stores.mjs` is still a mandatory go-live step (`GO_LIVE_CHECKLIST.md` §6.2) — without it the real environment has no showcase stores and the homepage spotlight cannot page.

**THE PURGE GATE (2026-08-03) — the general lesson, worth more than the seeders.** `purge()` took a WHERE clause and ran it. Both callers passed a predicate a real store cannot satisfy, so the behaviour was correct for as long as every caller happened to be careful — **the safety lived in the callers, not in the function**, and a third caller or one widened constant would have deleted real stores, their whole catalogue and their orders with nothing in the way. Now, in `seed-db.mjs`:

1. **A caller NAMES a scope, it never writes one** — `purge(db, 'demo')`. An unknown name throws; there is no parameter through which arbitrary SQL reaches a DELETE.
2. **A scope is verified to be a SUBSET of `DISPOSABLE_*` before anything is deleted.** The two layers are deliberately **not derived from each other**: layer 1 stops a new caller, layer 2 stops an edit to a scope constant, and layer 1 alone cannot catch that.
3. **A grep guard** (`tests/seed-purge-gate.test.ts`) blocks a script that skips `purge` and writes its own `DELETE FROM stores|sellers|orders`. A runtime gate only protects callers that go through it.

Each layer was sabotaged separately and each has a test that fails for it alone. **The bug this exposed: `purgeOrdersOfStores` deleted a whole order because it touched ONE demo store** — a cart can span several stores, so a real seller's order and its money went with the demo one. Now only orders whose *every* store is disposable are deleted; the rest are counted and reported, and a slug matching no store row counts as NOT disposable (nothing is left to prove it was seeded). Verified read-only against the live DB before shipping: 35 demo stores / 176 orders and 3 showcase stores all inside the disposable set, zero shared orders — the gate does not block today's `--clean`.

Also note: predicates here are SQL **literals**, not bind parameters. A scope clause and the disposable clause meet inside one statement, so two independently written fragments would have to agree on placeholder numbers — and a fragment that never mentions `$2` makes Postgres reject the call outright.

Related: [[project_db_migration_indexes]], [[reference_demo_data_script]], [[reference_go_live_checklist]]

**The file half is fully gone (2026-08-02, buyer-state diff; `data/` itself was deleted 2026-08-03).** The last piece was the demo seeder's favourite/wishlist COUNTS, written to two JSON files — one with no live reader at all, one keyed by bare product slug so its numbers were wrong on arrival. They are rows in `favorite_stores` / `wishlist_items` now, written inside `writeCatalog`'s transaction, and `seed-demo-data.mjs` no longer imports `node:fs` at all. **The rule that produced this, stated once: a seeder's half moves in the same diff as its module** — otherwise the seeder writes somewhere nobody reads and reports success, which is exactly the failure at the top of this memory. Verified the way the traffic half was: `tests/seed-db.test.ts` reads the seeded figures back through the application's own readers (`countFavoriteStores` / `getWishlistCountsForStore`), not through the tables.
