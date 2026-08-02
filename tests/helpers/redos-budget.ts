/**
 * The wall-clock ceiling every ReDoS guard test asserts against, in one place.
 *
 * **What these tests are for.** A quadratic regular expression on request input stalls SSR — the
 * class recorded in the repo's own history, with `^-+|-+$` measured at 65ms on 8k interior dashes
 * and 4.7s on 64k. The distance between a linear rule and a backtracking one on these inputs is
 * milliseconds against minutes.
 *
 * **Why one generous number and not a tight one per call site.** Three of these existed with
 * hand-picked ceilings of 20ms, 50ms and 100ms, against real costs measured 2026-08-02 of 0.00ms,
 * 0.01ms and 6.5ms. Every one of them looks like an ample margin and none of them is: an absolute
 * ceiling in the tens of milliseconds is inside the range of a GC pause or a scheduler preemption
 * once eight vitest workers share the CPU, and two of the three went red in a full run and green
 * when re-run alone. That is not a signal, it is noise wearing a signal's clothes — and the repo
 * already learned this once, in `seller-auth-password.test.ts`: a timing assertion sensitive to a
 * busy machine gets muted, and a muted security test protects nothing.
 *
 * 1500ms keeps a ≥230× margin over the slowest of the three and still fails by whole seconds the
 * moment a rule goes quadratic. It is a detector of catastrophes, not a performance benchmark; if
 * a function's constant factor is what needs watching, that wants a benchmark, not this.
 */
export const REDOS_BUDGET_MS = 1500;

/** Milliseconds `run` took, for asserting against `REDOS_BUDGET_MS`. */
export function elapsedMs(run: () => void): number {
  const started = Date.now();
  run();
  return Date.now() - started;
}
