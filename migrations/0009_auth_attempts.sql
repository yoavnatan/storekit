-- 0009_auth_attempts — throttling failed sign-in attempts (GO_LIVE §7).
--
-- Until this table, every credential surface on the platform accepted guesses at whatever rate the
-- network allowed: seller login, seller register (which reveals whether an address is registered)
-- and the admin password, which is a SINGLE shared secret with no second factor and full access to
-- every seller, every order and every number in the platform. A script making a few hundred requests
-- a second against `/admin/login` was, until now, bounded only by how fast bcrypt answers.
--
-- **Why the counter lives in Postgres and not in the process.** A `Map` in module scope is the
-- three-line version of this and it is worth nothing here, for exactly the reason
-- `checkout-idempotency` was moved off its in-process `Mutex` (DB_MIGRATION_PLAN.md §4): the
-- deploy that runs a second instance silently doubles every limit, and a rolling deploy resets all
-- of them to zero at the moment an attacker is most likely still running. A limiter whose ceiling
-- depends on how many copies of the app happen to be up is not a limit. The same argument rules out
-- keying anything to a cookie or to session state — the client chooses those.
--
-- **One row per bucket, and the bucket is a caller-supplied string** (`login:email@x`, `ip:1.2.3.4`,
-- `admin-ip:1.2.3.4`) rather than a pair of typed columns. The shape of an identity differs per
-- surface — the admin has no username to key on, only an address — and the alternative is a nullable
-- column per surface plus a partial unique index over each combination. `src/lib/rate-limit.ts` owns
-- the naming; this table only counts.
--
-- **Fixed window, not a sliding log.** A sliding window means one row per attempt and a COUNT over a
-- range on every check; a fixed window is one row per bucket, updated in place, and its known
-- weakness (up to 2× the limit across a boundary) is irrelevant against a limit whose job is to turn
-- unbounded guessing into a handful of tries per quarter hour. The window is not stored — it is
-- passed in by the caller with the limit, so changing the policy is a constant in one TS file rather
-- than a migration.
--
-- **`attempts` counts FAILURES only, and a success deletes the row.** Counting every attempt would
-- lock out the person who genuinely signs in and out repeatedly, which is a real seller on a shared
-- machine, while doing nothing extra to the attacker — who by definition is producing failures. The
-- delete-on-success is also what keeps the table small in normal use: a row exists only between a
-- user's first typo and their next correct password.

CREATE TABLE auth_attempts (
  -- `<surface>:<identity>`, built by lib/rate-limit.ts. Opaque here on purpose.
  bucket       text PRIMARY KEY,
  attempts     integer     NOT NULL DEFAULT 1,
  -- Start of the current window. Rolled forward by the same statement that increments, which is
  -- what makes "has the window expired" and "count this attempt" one atomic decision rather than a
  -- read followed by a write two instances can interleave.
  window_start timestamptz NOT NULL DEFAULT now()
);

-- The purge job (`registry.ts#purgeAuthAttempts`) deletes by `window_start`, and that scan is the
-- only access that is not by primary key. It stays cheap for the same reason `job_runs` needs no
-- index: in normal operation this table holds a handful of rows, because success deletes them. The
-- index exists for the case the job is FOR — a broad credential-stuffing run leaving one row per
-- address tried — where a sequential scan over that leftover is the thing being cleaned up.
CREATE INDEX auth_attempts_window_start_idx ON auth_attempts (window_start);
