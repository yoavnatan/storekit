-- `stores.published_at` defaults to now(), and `createStore` is the one writer that says otherwise.
--
-- 20260823_203823 added the column with no default, which made every row written OUTSIDE the
-- application unpublished: the demo and showcase seeders (`scripts/lib/seed-db.mjs`,
-- `db-import.mjs`) and the ~30 test files that `INSERT INTO stores` directly. The visible symptom
-- was the whole checkout suite failing — a seeded store is now unsellable, correctly, because
-- nothing had ever told it that it was live.
--
-- **The default is the honest value for those rows.** A store written straight into this table by a
-- seeder or a fixture is a store that is simply THERE — there is no seller who built it, no card
-- that was entered, nobody waiting on PayMe. "Already on the site" is what it means. What has a
-- publication decision to make is a shop a real person opened, and `stores.ts#createStore` is the
-- only code path that opens one; it now writes NULL explicitly, so the interesting case is stated
-- rather than inherited.
--
-- Reading it the other way round — "the default is live, so a new store is live" — is the mistake
-- this comment exists to prevent. Grep `INSERT INTO stores` before assuming: there is exactly one
-- in `src/`, and it names this column.

ALTER TABLE stores ALTER COLUMN published_at SET DEFAULT now();
