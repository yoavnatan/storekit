/**
 * **A share of the machine each, instead of a queue.**
 *
 * This file replaces `test-lock.mjs`, which serialised the test suite across every session on the
 * machine. That lock was right about the problem and wrong about the remedy, and the measurement
 * that settles it was taken on 2026-08-20 with `verify --all --no-cache` on a 12-core machine:
 *
 *     verify: waiting for another session's tests (pid 49120)…
 *     verify: green — astro check 85s · lint 7s · test 219s · db migrations 1s
 *     549.05s user  93.12s system  123% cpu  8:40.52 total
 *
 * The checks run concurrently, so the critical path of that run was the test step: 3m39s. It took
 * 8m40s. **Five of those minutes were spent standing in the lock queue at 123% CPU** — one and a
 * fraction of twelve cores busy, ten idle, because the only thing the machine was allowed to do was
 * already being done by somebody else. The lock's own docstring argued that "six suites take the
 * same total time interleaved or serialised". That is true of total CPU and false of the number the
 * owner actually experiences, which is how long HIS turn takes: serialised, a session's wall clock
 * is the sum of everybody's suites instead of the length of its own.
 *
 * It also scaled the wrong way, which is what turned it into a wall. Queue length is the session
 * count, so a sixth session waits five suites — around eighteen minutes for one verify. The owner's
 * requirement, stated 2026-08-20 after being offered a session ceiling and refusing it, is that he
 * must be able to run more than two sessions at once.
 *
 * **What the lock was actually preventing**, and this half of its reasoning is kept intact: `vitest`
 * sizes its worker pool from the CPU count, so N uncapped suites asked for N machines. Six of them
 * put database-backed test files past the 30s ceiling — a different random subset each run, each
 * passing in ~2s alone — and later starved workers before they could boot at all. None of that was a
 * bug in a test. It was over-subscription.
 *
 * Over-subscription has two remedies and serialising is the blunt one: it bounds the total by
 * letting exactly one run exist. Dividing bounds the same total while everybody keeps running. So
 * this hands out a SHARE — every live test run claims one, the shares sum to a budget the machine
 * can serve, and nobody waits. One session takes four workers, two take two each, three take one
 * each: the machine stays busy, nothing queues, and no run is ever handed more of it than exists.
 *
 * **And the budget is counted in real cores, which is the correction that made the two previous
 * attempts at this wrong by a factor of two.** See `physicalCores()` below: the machine reports 12
 * and has 6.
 *
 * **Nothing about correctness depended on the exclusion**, and that was checked rather than assumed
 * before this replaced it. `tests/helpers/db-global-setup.ts` builds its image under
 * `node_modules/.cache/`, which is per checkout, and hands every test file its own copy — two
 * sessions' suites share no file and no database. The lock was a CPU remedy wearing a mutex, and it
 * never claimed otherwise: read its "Why only the test step" paragraph, which is entirely about
 * cores.
 *
 * The layer that still has to exist beside this one is `verify.mjs` running the non-test checks
 * under `nice`. `astro check` is 54-140s of full-CPU work that this budget cannot see, and a booting
 * worker that loses the CPU to it dies on a timeout no `testTimeout` can reach.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * **Cores that can actually run something at the same time — not hyperthreads.**
 *
 * This is the correction that made every earlier number in this story wrong by a factor of two.
 * `availableParallelism()` reports 12 on the machine this project is built on, and both the previous
 * worker caps were reasoned about as if that were twelve cores. It is a 2019 i7-9750H: **six
 * physical cores, twelve threads.** Hyperthreads share an execution unit, so a second thread on a
 * busy core adds perhaps 20-30% throughput, not another core — and a vitest worker that is trying to
 * BOOT needs a real one, on time, or it dies on a timeout no `testTimeout` can reach. Budgeting the
 * logical count is how "four workers each, two sessions" came out to eight on six cores while
 * `astro check`, an editor and the OS wanted their own, and then read as an unexplainable red.
 *
 * `sysctl` because Node exposes no physical count on any platform. By ABSOLUTE path, which is not
 * pedantry and not the linter being appeased: resolving a command through `PATH` runs whatever a
 * writable directory earlier in it happens to be called that (`sonarjs/no-os-command-from-path`), so
 * a helper that decides how much of the machine to use would be executing an attacker's binary. When
 * it is unavailable — Linux, a container, anything that is not macOS — half the logical count is the
 * right guess for an SMT machine and merely conservative on one without SMT, which is the safe
 * direction here: too few workers is slow, too many is red.
 */
function physicalCores() {
  try {
    const n = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.physicalcpu'], { encoding: 'utf8' }).trim());
    if (Number.isInteger(n) && n > 0) return n;
  } catch { /* not macOS, or no sysctl */ }
  return Math.max(1, Math.floor((availableParallelism?.() ?? 2) / 2));
}

/**
 * Machine-wide by design, exactly as the lock was: the worktrees are separate checkouts sharing one
 * CPU, so a directory inside any of them would not see the others. Overridable because the tests for
 * this module cannot run against the real path — `verify` holds a claim for the whole suite those
 * tests are part of, so they would be measuring themselves. Read per call, not at import, so a test
 * need not control module load order.
 */
const claimsDir = () => process.env.STOREKIT_TEST_CLAIMS_DIR || join(tmpdir(), 'storekit-verify-claims');

/**
 * What every test run on this machine may demand between them.
 *
 * Two cores held back, not zero, and on a six-core machine that is a third of it — deliberately.
 * `astro check` is running beside this (niced, but running and single-threaded), the owner keeps an
 * `astro dev` up all day, VS Code has its own language servers, and on 2026-08-20 macOS's
 * `mediaanalysisd` was measured holding 27-89% of a core for twenty-eight hours straight. A budget
 * that claims every core reproduces exactly the starvation it exists to prevent. Four, here.
 */
const BUDGET = Math.max(2, physicalCores() - 2);

/**
 * The ceiling for a single run, and it is not arbitrary — it is the number the 2026-08-19 session
 * measured when it capped `vitest.config.ts`: fully green in 39s at four workers against 131s
 * serial, i.e. four was FASTER than twelve on a contended machine, because twelve workers on twelve
 * contended cores spend their time context-switching. So one session alone still takes four rather
 * than the whole budget; the extra six would cost it time instead of saving any.
 */
const MAX_PER_RUN = 4;

/**
 * A claim older than this belongs to a run that died and left its file behind. Same reasoning and
 * the same number as the lock's stale window: longer than the slowest honest suite, short enough
 * that a crashed session does not shrink everyone's share for a coffee break.
 */
const STALE_MS = 15 * 60 * 1000;

/** `kill(pid, 0)` tests existence without signalling. */
function alive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Live claims, pruning dead and stale ones as it goes.
 *
 * The PID is read from the file's NAME when its contents cannot be parsed, because an unparseable
 * claim is usually one being written this instant by a run that is just starting — and sweeping it
 * would hand its cores out twice. Naming the file after the PID means that case still resolves to
 * the right answer instead of guessing.
 */
function liveClaims(dir) {
  const live = [];
  let names;
  try { names = readdirSync(dir); } catch { return live; }
  for (const name of names) {
    const file = join(dir, name);
    let claim = null;
    try { claim = JSON.parse(readFileSync(file, 'utf8')); } catch { /* half-written, fall back */ }
    const pid = Number.isInteger(claim?.pid) ? claim.pid : Number.parseInt(name, 10);
    const at = Number.isInteger(claim?.at) ? claim.at : Date.now();
    if (alive(pid) && Date.now() - at < STALE_MS) { live.push(pid); continue; }
    try { rmSync(file, { force: true }); } catch { /* another run swept it first */ }
  }
  return live;
}

/**
 * Claim a share of the machine's test workers. Returns `{ workers, release }` and **never waits**.
 *
 * `onShare(workers, runs)` is called once with what was granted, so a run using fewer workers than
 * usual can say why instead of being quietly slower. It stays silent when nothing else is running,
 * which is inherited from the lock and is the right default: the single-session case is most of them
 * and should print nothing.
 *
 * The share is computed AFTER this run's own claim is written, so it counts itself. Two runs
 * starting in the same instant then both see two and both take half, rather than both seeing none
 * and both taking everything.
 */
export async function withWorkerShare(onShare) {
  const dir = claimsDir();
  let mine = null;
  try {
    mkdirSync(dir, { recursive: true });
    mine = join(dir, `${process.pid}.json`);
    writeFileSync(mine, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch {
    // The budget is an optimisation, not a gate. If the claims directory cannot be written, run at
    // the single-run ceiling rather than refuse to test — the lock made the same call about its own
    // failure, for the same reason.
    onShare?.(MAX_PER_RUN, 1);
    return { workers: MAX_PER_RUN, release: () => {} };
  }

  const runs = Math.max(1, liveClaims(dir).length);
  const workers = Math.max(1, Math.min(MAX_PER_RUN, Math.floor(BUDGET / runs)));
  onShare?.(workers, runs);

  let released = false;
  return {
    workers,
    // Idempotent, for the reason the lock's release was: a caller that releases in both a `finally`
    // and an error path must not delete a claim a recycled PID has since written.
    release: () => {
      if (released) return;
      released = true;
      try { if (mine && existsSync(mine)) rmSync(mine, { force: true }); } catch { /* already gone */ }
    },
  };
}

/** Exposed for the tests and for `verify`'s own reporting; not part of the claim protocol. */
export const workerBudget = () => BUDGET;
