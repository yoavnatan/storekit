---
name: project_migration_not_applied_class
description: "A new migration file is invisible to every check — the test suite builds its own DB, so verify stays green while the running app throws 'column X does not exist'; gated in verify since 2026-08-04"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4f1f04d2-03e6-4b3b-a201-7550b6581636
  modified: 2026-08-04T07:09:42.401Z
---

**Writing `migrations/NNNN_x.sql` does NOT change the database the dev server is talking to.** `npm run db:migrate` does, and nothing used to remind you.

**Why it is invisible:** the Vitest suite builds its own database from `migrations/` on every run, so a brand-new migration is applied *there* and every test passes. `astro check`, lint and tsc read files. So `npm run verify -- --all` reports green while every page that touches the new column dies with `error: column p.brand does not exist`. That is the whole failure mode: **full green, broken site.** It shipped on 2026-08-04 with `0008_product_brand`.

**Closed mechanically, not by memory:** `scripts/db-migrate.mjs --check` lists pending migrations and **exits 1**, and `verify.mjs` runs it whenever the diff touches `migrations/`. The failure names the fix (`npm run db:migrate`), because the person who sees it is the one who just wrote the migration and has no reason to suspect their own database. With no `DATABASE_URL` it reports "skipped" and exits 0, so a clone without Postgres is not a failure.

**The generalisable lesson:** a check that builds its own copy of a dependency cannot tell you about the real one. Same shape as any fixture-backed test — [[project_all_data_is_demo]] is the data version of it.

Related: [[project_db_migration_indexes]], [[project_session_speed]], [[feedback_dev_server]] (the dev server serves stale bundles for a different reason — don't confuse the two).
