-- 0007_job_runs — the scheduler's claim table (DB_MIGRATION_PLAN.md §8 stage 4a).
--
-- Three jobs were written, tested and never called, because there was no periodic trigger. The
-- question that had to be answered before any of them could be wired up was not "which timer" but
-- **where the timer is allowed to decide**, and the answer had to survive more than one instance:
-- the process-local Mutex that used to serialise checkout is gone (§7.5/§4), which is what opened
-- the gate to running several. A bare `setInterval` in each instance means every job runs N times
-- per period — for the feed pull that is N concurrent writes of the same catalog, and for the
-- campaign sweep N concurrent status flips of the same rows.
--
-- **Three options were on the table (§8). This is the third one, and why the other two lost.**
--
--   `pg_advisory_lock` — mutual exclusion, and nothing else. It holds only for the life of a
--   session, so it answers "is anyone running this right now" and cannot answer "when did this last
--   run". That second question is the one that matters on restart: an instance that reboots (a
--   deploy, a crash loop, a scale-up) has no memory, so with a lock alone every boot re-runs every
--   job. A deploy that restarts three instances would pull every seller's external feed three
--   times in a minute. The lock is the easy half; the schedule is the half that has to be durable.
--
--   an external cron calling a protected endpoint — correct, and the standard answer on a platform
--   whose processes sleep. It costs a second system to configure, a shared secret to rotate, and a
--   manual step in GO_LIVE that nobody sees fail: a cron that stops firing is silent, and the
--   symptom (stock drifting from the seller's real system) shows up weeks later as a mystery. This
--   platform's rule is zero-touch, and the app already runs as a long-lived Node process
--   (`npm start` → `dist/server/entry.mjs`), so it can hold its own timer. Worth revisiting the day
--   the host becomes serverless — and the table below is what makes that a swap of the TRIGGER
--   only: `runDueJobs()` is already safe to call from anywhere, by anyone, at any rate.
--
--   this table — a durable lease. It answers both questions in one statement, and the statement is
--   the same shape §7.5 and `claimCheckout` already proved: an atomic write whose affected-row
--   count IS the verdict. 1 = this instance owns the job, 0 = somebody else does, or it is not due.
--   No lock, no coordinator, correct at any number of instances.
--
-- **The two clauses in the claim do different jobs, and both are needed.**
--   `next_run_at <= now()`  — is it DUE? This is the durable half. It survives restarts, which is
--                             what stops a deploy from re-running everything, and it is stamped
--                             forward at CLAIM time (not at finish) so the period is a period and
--                             not "interval + however long the run took".
--   `lease_until` expired   — is anyone running it RIGHT NOW? Needed because a job can outlive its
--                             own interval: the feed pull fetches an arbitrary number of remote
--                             URLs. Without it, minute 61 of a 60-minute interval starts a second
--                             copy of a run still in progress. The lease expires by wall clock
--                             rather than being held by a connection, so a process that is killed
--                             mid-run does not leave the job stuck forever — the row simply becomes
--                             claimable again once the lease lapses.
--
-- There is deliberately no `state` column. "Running" is `lease_until > now()`, derived from the one
-- field that is already authoritative; a second field saying the same thing is a second field that
-- can disagree with it after a crash.
--
-- Idempotency is NOT enforced here and cannot be — a lease reduces double-runs, it does not
-- eliminate them (a paused process can wake past its own lease). Every registered job is written so
-- that running it twice is the same as running it once; `tests/jobs-scheduler.test.ts` asserts that
-- per job rather than trusting it.

CREATE TABLE job_runs (
  name             text PRIMARY KEY,
  -- The schedule. Stamped forward when the job is CLAIMED, so a slow run does not push the next
  -- one out; a run longer than its own interval is held off by the lease instead.
  next_run_at      timestamptz NOT NULL DEFAULT now(),
  -- Held while a run is in flight, NULL when idle. Expiry, not ownership, is what releases it.
  lease_until      timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  -- What the last run did, for anyone reading the table during an incident. `last_detail` is a
  -- one-line human summary, not a payload.
  --
  -- Text and not a boolean, because the honest domain has three values — never finished, finished
  -- well, finished badly — and a nullable boolean is the shape §7.12 forbids everywhere in this
  -- schema: `WHERE flag = false` silently drops the NULL rows, so the state that means "we have no
  -- idea" disappears from exactly the query looking for trouble. `NOT NULL DEFAULT false` would
  -- have been worse still: it would report every job that has never run as having failed.
  last_status      text CHECK (last_status IN ('ok', 'failed')),
  last_detail      text,
  last_duration_ms integer,
  run_count        bigint NOT NULL DEFAULT 0,
  fail_count       bigint NOT NULL DEFAULT 0
);

-- No index beyond the primary key, and that is a decision rather than an omission: this table holds
-- one row per registered job — three today — and every access is by name or a full scan of those
-- three rows. An index on `next_run_at` would never be chosen by the planner and would only be one
-- more thing the claim statement has to write.
