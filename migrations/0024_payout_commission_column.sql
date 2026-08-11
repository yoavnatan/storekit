-- The column migration 0023 describes and this database never got.
--
-- ── How that is possible with a checksum guard in place ──
-- `db-migrate.mjs` refuses to re-run an APPLIED migration whose text has changed, and that guard is
-- correct and did not fire: 0023 was never edited. What happened is one layer below it. Its body is
-- `CREATE TABLE IF NOT EXISTS seller_payouts (…)`, and the table already existed from an earlier
-- attempt — so Postgres skipped the whole statement, including the `commission_agorot` column, and
-- the ledger recorded 0023 as applied because it was: every statement ran, and one of them was a
-- no-op. **A checksum watches the FILE. Nothing was watching the SCHEMA.**
--
-- It was found on 2026-08-10 by an admin screen naming the column in a SELECT. Nothing had named it
-- explicitly before — `getPayoutsForSeller` does `SELECT *` — so the shape mismatch was invisible,
-- and the first thing that would have hit it is `createPayout`, which INSERTs into that column:
-- **the first real payout run on this database would have thrown, on the day money was due to go
-- out.** The tests could not have caught it either, and that is not a gap in them; they build their
-- own database from these files, where the column has always existed (memory
-- `project_migration_not_applied_class`).
--
-- `db-migrate.mjs` now also compares the live columns against what the migrations describe, so the
-- class is caught by the check rather than by a screen. This file is the repair.
--
-- Additive and idempotent: a database that DID get 0023 in full runs this as a no-op, and the
-- default means every existing payout row reads as "settled no commission", which is exactly what
-- rows written before the column existed did mean.
ALTER TABLE seller_payouts
  ADD COLUMN IF NOT EXISTS commission_agorot bigint NOT NULL DEFAULT 0 CHECK (commission_agorot >= 0);

COMMENT ON COLUMN seller_payouts.commission_agorot IS
  'The commission THIS payout settled — the increment, never the seller''s lifetime total. The releasable figure is cumulative, so the platform''s tax invoice has to be generated from the difference or it bills the same commission twice (payout-run.ts).';
