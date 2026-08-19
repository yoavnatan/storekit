/**
 * **One test suite at a time, across every session on this machine.**
 *
 * The problem, measured 2026-08-17 with six sessions live: `vitest` sizes its worker pool from the
 * CPU count, so six concurrent runs asked for roughly six times the machine. Nothing failed on an
 * assertion — six DIFFERENT database-backed test files timed out at ~32s against the 30s ceiling,
 * a different random subset every run, every one of them passing in ~2s alone. That is not
 * flakiness in the tests; it is the suite being handed a fraction of a core and a fixed wall-clock
 * deadline. `vitest.config.ts` already carries the story of the previous round of this, when the
 * timeout went 5s → 30s for exactly the same reason.
 *
 * **Why a lock and not a bigger timeout.** Raising the ceiling again is the treatment that already
 * failed once: it does not bound the contention, it just moves the number, and every future
 * genuinely-hung test costs the new ceiling before anyone hears about it. The contention is the
 * bug. Serialising the one contended step fixes it exactly, and costs nothing that was real work —
 * six suites sharing one machine take the same total time whether they interleave or queue, except
 * that queued they all pass.
 *
 * **Why only the test step** — and READ THE AMENDMENT BELOW, because half of this has expired.
 * `tsc`, `lint` and `astro check` are CPU-bound but short and have no wall-clock deadline inside
 * them, so contention makes them slower and never wrong. Tests are the only step where being slow
 * IS being wrong, and the only one touching a shared Postgres. So sessions stay parallel for
 * everything — editing, type-checking, linting — and queue for the seconds that actually conflict.
 *
 * **Amendment, 2026-08-19: "short" stopped being true, and this lock cannot cover the gap.**
 * `astro check` now measures 54–140s of full-CPU work on this codebase. It still cannot be WRONG
 * under contention, so it still does not belong in this lock — but while one session holds this
 * lock and boots its workers, another session's type-check can starve them before they answer, and
 * the symptom lands on the LOCK HOLDER, which is maximally confusing: it believes it has
 * exclusivity and it does, over the only thing this lock knows about. Twelve
 * `[vitest-pool]: Failed to start forks worker` errors in one run, zero failing assertions.
 * The layer that fixes it is a cap on what one run may demand — `vitest.config.ts`'s `maxForks`,
 * which carries the measurement. This lock is still right for what it does; it was never the whole
 * answer, and this paragraph exists so the next session does not widen it instead.
 *
 * **Stale locks cannot wedge the machine.** A holder that dies (crash, killed session, a laptop
 * closing) leaves its directory behind, so the lock records a PID and a timestamp and any waiter
 * may steal it once the holder is gone or has held it past `STALE_MS`. `mkdir` is the primitive
 * because it is atomic on every filesystem this repo runs on — a "check then create" is a race, and
 * this is the one place that race would be invisible.
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Machine-wide by design: the worktrees are separate checkouts of one repo sharing one CPU and one
 * database, so a lock inside any of them would not see the others.
 *
 * **Overridable, and the override is not a convenience — without it this module cannot be tested at
 * all.** `verify` holds this lock for the whole test run, so a test exercising `withTestLock` on the
 * real path waits for the suite it is itself part of and times out. Read per call rather than at
 * import, so a test can point it somewhere private without controlling module load order.
 */
const lockDir = () => process.env.STOREKIT_TEST_LOCK_DIR || join(tmpdir(), 'storekit-verify-test.lock');
const ownerFile = () => join(lockDir(), 'owner.json');

/** Longer than the slowest honest full run (~7 min under load, measured), short enough that a
 *  crashed holder does not block a session for a coffee break. */
const STALE_MS = 15 * 60 * 1000;

/** How often a waiter re-checks. Short enough to feel immediate, long enough not to spin a core. */
const POLL_MS = 400;

function holder() {
  try { return JSON.parse(readFileSync(ownerFile(), 'utf8')); } catch { return null; }
}

/** Is the recorded holder still alive? `kill(pid, 0)` tests existence without signalling. */
function alive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function expired() {
  const own = holder();
  // A lock directory with no readable owner file is a half-written or hand-deleted lock. Treat it as
  // stale rather than trusting it forever — but only once it is old enough that we cannot be racing
  // the holder between its mkdir and its write.
  if (!own) {
    try { return Date.now() - statSync(lockDir()).mtimeMs > 30_000; } catch { return true; }
  }
  return !alive(own.pid) || Date.now() - own.at > STALE_MS;
}

/**
 * Take the lock, waiting for whoever holds it. Returns a release function.
 *
 * `onWait` is called once, with the current holder, the first time this actually has to queue — so
 * the caller can say so rather than appearing to hang. Nothing is printed when the lock is free,
 * which is the normal single-session case.
 */
export async function withTestLock(onWait) {
  let announced = false;
  for (;;) {
    try {
      mkdirSync(lockDir());
      writeFileSync(ownerFile(), JSON.stringify({ pid: process.pid, at: Date.now() }));
      let released = false;
      return () => {
        // Idempotent: a caller that releases in both a `finally` and an error path must not delete a
        // lock some other session has since taken.
        if (released) return;
        released = true;
        try { rmSync(lockDir(), { recursive: true, force: true }); } catch { /* already gone */ }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (expired()) {
        try { rmSync(lockDir(), { recursive: true, force: true }); } catch { /* another waiter won */ }
        continue;
      }
      if (!announced) { announced = true; onWait?.(holder()); }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}
