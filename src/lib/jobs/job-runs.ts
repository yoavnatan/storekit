/**
 * The scheduler's claim table, as three statements (migration 0007).
 *
 * This module knows nothing about what a job DOES — it only answers "may this instance run
 * `name` right now", and records what happened when it finishes. `scheduler.ts` owns the loop,
 * `registry.ts` owns the work.
 *
 * The claim is one statement whose affected-row count is the whole answer, the same shape as
 * `checkout-idempotency.ts#claimCheckout` and the stock decrement in §7.5. There is no read-then-
 * write window to lose a race in, because there is no read.
 */
import { firstRow, query } from '../db.js';

/** What the last run of a job left behind. Read by tests and by anyone opening the table during
 *  an incident; nothing in the request path reads it. */
export interface JobRun {
  name: string;
  nextRunAt: string;
  leaseUntil?: string;
  startedAt?: string;
  finishedAt?: string;
  lastStatus?: 'ok' | 'failed';
  lastDetail?: string;
  lastDurationMs?: number;
  runCount: number;
  failCount: number;
}

interface JobRunRow {
  name: string;
  next_run_at: Date | string;
  lease_until: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  last_status: 'ok' | 'failed' | null;
  last_detail: string | null;
  last_duration_ms: number | null;
  run_count: number;
  fail_count: number;
}

const COLUMNS = `name, next_run_at, lease_until, started_at, finished_at,
                 last_status, last_detail, last_duration_ms, run_count, fail_count`;

function iso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toJobRun(row: JobRunRow): JobRun {
  const run: JobRun = {
    name: row.name,
    nextRunAt: iso(row.next_run_at)!,
    runCount: Number(row.run_count),
    failCount: Number(row.fail_count),
  };
  if (row.lease_until) run.leaseUntil = iso(row.lease_until);
  if (row.started_at) run.startedAt = iso(row.started_at);
  if (row.finished_at) run.finishedAt = iso(row.finished_at);
  if (row.last_status !== null) run.lastStatus = row.last_status;
  if (row.last_detail) run.lastDetail = row.last_detail;
  if (row.last_duration_ms !== null) run.lastDurationMs = row.last_duration_ms;
  return run;
}

/** How long a one-line run summary may be before it is cut. The column is `text`, so this is not a
 *  storage limit — it stops a job that returns an error message built from remote input (a feed
 *  URL, an HTTP body) from writing an unbounded string into a table meant to be readable. */
const MAX_DETAIL = 500;

/**
 * Take the job if it is due and nobody else is running it. `true` means this process owns it and
 * MUST call `finishJob` — including when the work throws.
 *
 * Both halves of the `WHERE` matter and they answer different questions; migration 0007 spells out
 * why. `next_run_at` is stamped forward here, at claim time, so the schedule is a fixed cadence
 * rather than "interval after whenever the last one happened to finish".
 *
 * The `INSERT` branch is what a job's very first run looks like: no row, so it is due immediately.
 * That is deliberate — on a fresh database every job runs once at startup, which for these three is
 * exactly the desired behaviour and is safe because each is idempotent.
 */
export async function claimJob(name: string, intervalSec: number, leaseSec: number): Promise<boolean> {
  const { rowCount } = await query<{ name: string }>(
    `INSERT INTO job_runs (name, next_run_at, lease_until, started_at)
     VALUES ($1,
             now() + ($2::double precision * interval '1 second'),
             now() + ($3::double precision * interval '1 second'),
             now())
     ON CONFLICT (name) DO UPDATE
        SET next_run_at = now() + ($2::double precision * interval '1 second'),
            lease_until = now() + ($3::double precision * interval '1 second'),
            started_at  = now()
      WHERE job_runs.next_run_at <= now()
        AND (job_runs.lease_until IS NULL OR job_runs.lease_until <= now())
     RETURNING name`,
    [name, intervalSec, leaseSec],
  );
  return rowCount === 1;
}

/**
 * Release the lease and record the outcome. Called from a `finally`, so a job that throws still
 * gives the lease back instead of blocking its own next run until the lease expires.
 *
 * `next_run_at` is deliberately NOT touched here: it was set when the job was claimed, and moving
 * it now would make the cadence depend on how long the run took.
 */
export async function finishJob(name: string, ok: boolean, detail: string, durationMs: number): Promise<void> {
  await query(
    `UPDATE job_runs
        SET lease_until = NULL,
            finished_at = now(),
            last_status = CASE WHEN $2 THEN 'ok' ELSE 'failed' END,
            last_detail = $3,
            last_duration_ms = $4,
            run_count = run_count + 1,
            fail_count = fail_count + CASE WHEN $2 THEN 0 ELSE 1 END
      WHERE name = $1`,
    [name, ok, detail.slice(0, MAX_DETAIL), Math.round(durationMs)],
  );
}

/** One job's row, or undefined if it has never run. */
export async function getJobRun(name: string): Promise<JobRun | undefined> {
  const row = await firstRow<JobRunRow>(`SELECT ${COLUMNS} FROM job_runs WHERE name = $1`, [name]);
  return row ? toJobRun(row) : undefined;
}
