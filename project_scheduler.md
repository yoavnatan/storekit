---
name: project_scheduler
description: Background jobs run on an in-process timer whose DECISION is a durable claim in job_runs; a new job must be idempotent and must infer nothing
metadata: 
  node_type: memory
  type: project
  originSessionId: a8715dc9-8c9d-4552-a1b1-49c667fda5e3
  modified: 2026-08-03T12:47:19.526Z
---

**§8 stage 4a COMPLETE 2026-08-03** (branch `db-stage-4a-scheduler`). Three jobs that had no
caller now run periodically: `purge-checkouts` (6h), `campaign-sweep` (15m), `feed-sync` (1h).

**The decision, so it is not re-litigated.** The timer is in-process (`src/lib/jobs/scheduler.ts`,
started from the first request via `ensureSchedulerStarted()` in the middleware — Astro's node
adapter has no server-start hook). But WHICH instance runs a job is a durable claim in `job_runs`
(migration 0007), not configuration, so the scheduler can stay on in every instance.
`pg_advisory_lock` lost because it cannot answer "when did this last run" — every restart would
re-run everything. An external cron lost because it is a second system, a secret to rotate, and a
GO_LIVE step that fails **silently**. `runDueJobs()` is the seam: moving to an external cron later
changes the trigger only.

**Adding a job — the two rules.**
1. **Idempotent, and asserted.** The lease reduces double-runs, it cannot rule them out. Prove it
   in a test (run twice, second pass changes nothing), and if it touches money or stock add it to
   `tests/reporting-invariants.test.ts` §8, which puts a whole pass between two readings of the
   platform's totals.
2. **A timer may infer NOTHING.** The three defects the diff review caught were all the same
   mistake — behaviour that is correct for a human, run unattended. The feed pull's column guess
   would have let a supplier's new `Price` column rewrite a store's prices hourly; a feed with no
   sku column would have re-created the whole catalogue every hour; and the run was unbounded, so
   at 1000 feed stores it would outlast its own lease. Anything ambiguous must be REFUSED, and any
   cap must be announced (a silent truncation reads as "everyone was covered").

Related: [[project_db_migration_indexes]] · [[project_contextual_search_strategy]] (4b, still
blocked on the owner's embedding-provider choice — do not re-propose) · [[feedback_bug_defence_layers]]
