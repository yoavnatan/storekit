# Speed — every mechanism this project actually built

Not advice. Every item below is a mechanism that exists, with the measurement that justified it and
the enforcer that keeps it. Each one names its enforcer or says it has none — an unenforced rule is
a preference, and preferences decay (`communication.md` is the proof).

The measurements are from this stack on this machine. Carry the SHAPE to a new project and re-measure
the numbers; a copied number that was never re-taken is the same failure as a ✅ over code that moved.

---

## 1. One command runs the checks — ENFORCED (PreToolUse blocks the alternatives)

Type-check, lint and tests run only through `npm run verify`. Running any of them by hand is blocked.

Serial and cold: ~115s per checkpoint (tsc 9s / astro check 39s / lint 37s / vitest 30s). A session
with eight checkpoints spends a quarter of an hour waiting. Three things fix it without weakening the
check: run them concurrently (cost is the slowest, not the sum), keep their own caches warm (eslint
37s→4s, tsc 9s→4s), and scope by the working diff (a docs-only turn runs nothing). Typical warm
checkpoint: ~30s.

Two properties or it lies: a skipped check is always NAMED in the output, and `--all` disables
scoping — because a check skipped for a file committed earlier in the session is still a check that
did not run.

One trap, paid for once: the eslint cache went stale into a false RED. When it reports an error you
cannot see in the code, confirm with an uncached run before editing anything.

## 2. The turn cannot end on red — ENFORCED (Stop hook)

Runs the full `--all` pass and blocks the turn on failure. Bounded at two blocks per diff
fingerprint, then it warns and lets the turn end. A gate with no escape hatch gets switched off.

This is the rule that was never once broken here, while every written-only rule was. It is the
single most important line in this folder.

## 3. Don't re-run what already passed — ENFORCED (fingerprint cache)

A successful run is recorded against a content fingerprint of its inputs. A turn that changed no code
exits instantly instead of spending 30s proving it again. The review gate uses the same fingerprint,
so reviewing and then changing one more line correctly invalidates both.

## 4. A share of the machine, not a queue — ENFORCED (test-concurrency.mjs)

The first version serialised the test suite across every session on the machine with a lock. Measured
on 12 cores: one `verify --all --no-cache` took 8m40s of which five minutes was queueing behind
another session. The lock was right about the problem and wrong about the remedy — the replacement
gives each session a share of the workers instead of making it wait for all of them.

## 5. A dead worker is re-run narrowly, not wholly — ENFORCED (starved-workers.mjs)

A red run with no failing assertion is a vitest worker that never started, not a bug. Re-running the
whole suite to recover it cost ~200s on a run that already took 407s, and it happened on every full
run that day. Now only the files vitest says never started are re-run. Same tree, same command:
407s red → 143.5s green.

The cause was memory, not CPU contention: free RAM measured 7-19MB at the peak of every failing run.
Two obvious cures — serialising the test step, and re-nicing the child — were both built and measured
WORSE (471s, still red). Both attempts are written down so nobody re-walks them.

## 6. Nothing keeps running for a tree that is gone — ENFORCED (SessionStart reap)

A `verify` belonging to a removed worktree kept burning cores and starving the live session's tests.
Killed at session start.

## 7. Don't shrink a check to speed it up — measured, not enforced

Pointing the type-checker at a narrower file set looked like half a checkpoint saved (88s → 40s). It
was 2 seconds, because a full run is CPU-bound and the other checks just take turns: 1:24.7 old
shape, 1:22.6 new shape, for more CPU and a second config to keep in sync. The only thing that moves
this number is doing less total work.

## 8. Independent work goes in one batch — not enforced

Sequential `await`s on independent queries are sequential round trips; one `Promise.all`. The same
rule applies to me: independent reads and searches go in ONE message, not one tool call per turn.
This is the cheapest unenforced win in the file and the one I break most.

## 9. Rules arrive on contact, not at session start — ENFORCED (PostToolUse injection)

The strongest mechanism here, and the most transferable. Instead of hoping a session read the money
rules at the start, a hook injects them the moment a money file is edited. Measured over 40 sessions:
only 8 ever touched that surface — so 32 sessions were carrying rules they had no use for, and the 8
that needed them got them at the moment of use. Same pattern for the CSS conversion rule.

## 10. Reading the instructions is scoped, not linear — not enforced

The instructions file is 931 lines, of which ~80% is a reference index that is grepped, never read.
The always-read part is under a character ratchet that may only ever come down, enforced by a test.
Adding a rule is paid for by MOVING rationale to the file it governs — relocation, never deletion.

---

## The product side — same principle, different surface

These are runtime mechanisms, listed because they were each bought with a measurement and each has a
guard. They transfer as patterns, not as code.

Every image URL goes through one module (`lib/cdn.ts`), so optimization is never per-surface and
never by reminder. Guard test scans the tree.

Every repeating fetch goes through one poller that stops while the tab is hidden. Browsers throttle
background timers to ~once a minute rather than stopping them, so a forgotten tab costs one request
per minute per user forever. Two modules had solved this independently and differently before it was
made one.

Anything the site header computes is the cost of the SITE — it renders on every page, so its
indicators must be a fixed number of queries no matter how many stores exist, never a per-item loop.

Cold CDN render measured 0.80s against 0.19s warm, which is an LCP problem invisible in dev; measure
on a build.

Dashboard panels render lazily; the products table still ships 803KB, which is written down as an
open number rather than quietly ignored.
