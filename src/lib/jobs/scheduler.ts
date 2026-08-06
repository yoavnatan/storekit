/**
 * The periodic trigger — the one thing DB_MIGRATION_PLAN.md §8 stage 4a was missing.
 *
 * **Where it runs, and why here.** The app is a long-lived Node process (`npm start` →
 * `dist/server/entry.mjs`), so it can hold its own timer, and holding it in-process is what keeps
 * the platform zero-touch: no second system to configure, no shared secret to rotate, no external
 * cron that can stop firing silently. The reason a bare timer was not enough — and the reason
 * `pg_advisory_lock` and an external cron were both considered and rejected — is written out in
 * migration 0007, next to the table that replaced them. In one line: several instances may run at
 * once now that the process-local mutex is gone (§7.5), so the *timer* is local but the *decision*
 * is a durable claim in Postgres, and only one instance wins it.
 *
 * **This module is the trigger and nothing else.** It does not know what any job does; it ticks,
 * asks `job-runs.ts` for permission, and runs whatever `registry.ts` lists. That separation is what
 * lets the trigger be swapped without touching the work — the day this platform runs somewhere its
 * processes sleep between requests, an endpoint or a real cron calls `runDueJobs()` and everything
 * below stays exactly as it is, still safe against being called twice at once.
 *
 * **Jobs are started concurrently and guarded per job, not per tick.** A tick-wide guard would let
 * the hourly feed pull — an outbound request per store, to servers we do not control — hold up the
 * quarter-hourly campaign sweep behind it. The in-flight set is per name, so a slow job delays only
 * itself. Cross-instance overlap is a different question and the lease answers it.
 */
import { serverEnv } from '../runtime-env.js';
import { isDbConfigured } from '../db.js';
import { logError } from '../error-log.js';
import { claimJob, finishJob } from './job-runs.js';
import { JOBS, type Job } from './registry.js';

/** How often the process asks whether anything is due. Not the interval of any job — those are on
 *  the jobs, in the table — so this is only the resolution the schedule is honoured at. A minute is
 *  far below the shortest interval (15 min) and costs one small query per tick per instance. */
const TICK_MS = 60_000;

/** The first tick waits, so a boot burst (deploy, restart loop) does not fire jobs while the pool
 *  is still opening its first connection and the process is busiest. Nothing is lost by waiting:
 *  `next_run_at` is durable, so a job that was due five minutes ago is still due now. */
const FIRST_TICK_MS = 15_000;

const timers: NodeJS.Timeout[] = [];
const inFlight = new Set<string>();

/** `disabled` is a third state and not just "not running": it is the ANSWER to `schedulerEnabled`,
 *  remembered, so a process configured without a scheduler stops re-asking on every request. */
let state: 'stopped' | 'running' | 'disabled' = 'stopped';

/**
 * Should this process run jobs at all?
 *
 * **The default answers the question, so nobody has to remember to.** This started as
 * "on wherever `DATABASE_URL` is set, switch it off by hand where it should not run" — and the
 * place it should not run is a developer's machine, which is exactly the place a checklist item
 * gets skipped. `.env` here holds the REAL Neon credentials, so an unset variable would have meant
 * `npm run dev` quietly pulling every seller's feed URL from a home network and writing the
 * production catalogue. A safety that depends on being remembered is not one.
 *
 * So the default is the build itself: the dev server does not run jobs, the built server does.
 * That is a build-time fact rather than configuration, which is why it is the one place
 * `import.meta.env` is the right tool and not the trap the runtime-env rule warns about
 * (`runtime-env.ts` — a *value* baked at build time is the bug; "am I the dev server" is baked at
 * build time by definition).
 *
 * `SCHEDULER_ENABLED` stays, and now overrides in BOTH directions, because a one-way switch could
 * not express either case that actually comes up: `1` runs jobs under `astro dev` when you are
 * working on one, and `0` silences a built instance that shares the database without being the
 * server (a maintenance box, a load-test replica).
 *
 * Off without Postgres either way — there is no claim table to coordinate through.
 */
export function schedulerEnabled(): boolean {
  if (!isDbConfigured()) return false;
  const configured = serverEnv('SCHEDULER_ENABLED');
  if (configured === '0') return false;
  if (configured === '1') return true;
  return import.meta.env.PROD;
}

/**
 * Every run is bounded by its own lease, and a run that passes it is ABANDONED.
 *
 * **The failure this closes is a job that hangs rather than throws.** A throw is handled — it is
 * caught, logged and the lease released. A promise that never settles is not: `inFlight` keeps that
 * job's name for the life of the process, so it never runs again here; `finishJob` is never called,
 * so its row keeps whatever `last_status` the PREVIOUS run left, very possibly `'ok'`. The result is
 * a job that stopped weeks ago while the table says it is fine — the exact silent-failure shape
 * every scheduled job in this registry exists to prevent, happening to the scheduler itself. Nothing
 * blocks a request either way (the timer is `unref`'d and rides no request), which is precisely why
 * nobody would notice.
 *
 * **Why the lease is the right number and not a new one to choose.** `leaseSec` already means "past
 * this point another instance may run this job", so a run still going at its lease is one the system
 * has ALREADY decided may be overlapped. Timing out there risks nothing that was not permitted a
 * millisecond earlier, and it needs no judgement call: raising a job's lease raises its deadline
 * with it, in the one place a lease is declared.
 *
 * **The abandoned work keeps running — we cannot kill a promise.** That is safe here for the reason
 * `registry.ts` states as a hard requirement of every entry: each job is idempotent, so a zombie
 * finishing its writes after a fresh run has started leaves the same state either way. The
 * bookkeeping recovers immediately: the row is marked failed, the lease is released, and the next
 * interval runs the job for real.
 */
function withLeaseDeadline(job: Job, run: Promise<string>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`did not finish inside its ${job.leaseSec}s lease and was abandoned`)),
      job.leaseSec * 1000,
    );
    // Never a reason for the process to stay alive, same rule as the tick timers.
    timer.unref?.();
    // Handlers are attached to the ORIGINAL promise, so a zombie that eventually rejects is handled
    // and cannot surface as an unhandled rejection long after the run was written off.
    run.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Run one job if it is due and unclaimed. Returns what was recorded, or `null` if this instance did
 * not get it (another instance holds it, or it is simply not due yet).
 *
 * The `finally` is the important part: a job that throws — or is abandoned at its lease, see above —
 * still releases its lease, so its next run is at its next interval rather than whenever the lease
 * happens to expire.
 */
export async function runJobIfDue(job: Job): Promise<string | null> {
  if (inFlight.has(job.name)) return null;
  if (!(await claimJob(job.name, job.intervalSec, job.leaseSec))) return null;

  inFlight.add(job.name);
  const startedAt = Date.now();
  let ok = false;
  let detail = '';
  try {
    detail = await withLeaseDeadline(job, job.run());
    ok = true;
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
    // The admin Alerts tab is where a failing job has to become visible — a scheduled job nobody
    // watches is exactly the thing that fails quietly for weeks. `logError` is fire-and-forget and
    // capped, so it cannot itself become the reason a tick stalls.
    void logError({
      source: 'server',
      route: `job:${job.name}`,
      message: `scheduled job "${job.name}" failed: ${detail}`,
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      resolutionHint: 'The job releases its lease and retries at its next interval; no action is needed unless it keeps failing.',
    });
  } finally {
    inFlight.delete(job.name);
    try {
      await finishJob(job.name, ok, detail, Date.now() - startedAt);
    } catch {
      // The work is done and recorded nowhere. The lease expires on its own clock, so the schedule
      // recovers by itself; throwing here would turn a bookkeeping failure into a failed job.
    }
  }
  return detail;
}

/**
 * One pass over the registry. Public because it is the seam: whatever ends up driving the schedule
 * — this module's timer today, an endpoint or a real cron later — calls exactly this, and the claim
 * table makes it safe to call from anywhere, at any rate, by any number of callers.
 */
export async function runDueJobs(jobs: readonly Job[] = JOBS): Promise<Record<string, string>> {
  const results = await Promise.all(jobs.map(async (job) => [job.name, await runJobIfDue(job)] as const));
  return Object.fromEntries(results.filter((r): r is readonly [string, string] => r[1] !== null));
}

async function tick(): Promise<void> {
  try {
    await runDueJobs();
  } catch (err) {
    // Reached only if the CLAIM itself fails — the database is down or unreachable. Every job's own
    // failure is already handled inside runJobIfDue.
    console.error('[scheduler] tick failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Start ticking. Idempotent — a second call while already running does nothing, which is what makes
 * it safe to call from the request path.
 *
 * Both timers are `unref`'d: the scheduler must never be the reason a process stays alive. A server
 * that has finished serving should exit, and a test or script that imports this file must not hang.
 */
export function startScheduler(): boolean {
  if (state === 'running') return false;
  if (!schedulerEnabled()) { state = 'disabled'; return false; }
  state = 'running';
  timers.push(setTimeout(() => void tick(), FIRST_TICK_MS));
  timers.push(setInterval(() => void tick(), TICK_MS));
  for (const t of timers) t.unref();

  // **A timer outlives the module that created it, and hot-reload is where that bites.**
  // Observed, not theorised: a dev server left running for hours had claimed and re-claimed jobs on
  // the real database every minute, each time recording a claim that never finished. Every file
  // save replaces this module, but `setInterval` belongs to the Node event loop, not to the module
  // graph — so the previous instance kept ticking against half-disposed imports, taking the claim
  // and then failing to write the result. Nothing was corrupted (the lease expires and the row is
  // reclaimable), but every reload added another zombie, and they all held real leases.
  // `dispose` is Vite's own answer to exactly this: it runs on the outgoing module before the new
  // one takes over. Absent in a production build, where modules are never replaced.
  import.meta.hot?.dispose(() => stopScheduler());
  return true;
}

/** Stop ticking. Jobs already in flight are left to finish and release their own leases. Resets to
 *  `stopped` rather than `disabled`, so a test that stops it can start it again under new config. */
export function stopScheduler(): void {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
  state = 'stopped';
}

/** Called from the first request the server handles (`src/middleware.ts`).
 *
 *  Astro's node adapter has no "server started" hook, and a module-level side effect would fire
 *  whenever the bundler happened to load this file — including in a test that imported it for one
 *  pure function. A boolean check on the request path is the cost of starting it somewhere that is
 *  guaranteed to happen exactly once per live process, and only in a process actually serving. */
export function ensureSchedulerStarted(): void {
  if (state !== 'stopped') return;
  try {
    startScheduler();
  } catch (err) {
    // This runs on the request path, and the middleware re-throws what it catches. A background
    // scheduler that failed to start must never be the reason a visitor gets a 500 — and it must not
    // retry on every subsequent request either, which is why the state is settled before returning.
    state = 'disabled';
    console.error('[scheduler] failed to start:', err instanceof Error ? err.message : err);
  }
}
