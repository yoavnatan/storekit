#!/bin/bash
# SessionStart — kill any `verify` still running for a worktree that no longer exists.
#
# ── The night this cost (owner, 2026-08-21: *"אי אפשר כל לילה לעבור את אותו הסיפור"*) ──
#
# A session finished, merged, and removed its worktree — while its own `npm run verify` was still
# running inside it. Nothing reaps that: the directory goes, the process does not. It sat there for
# 24 minutes holding two of the machine's four test workers, verifying a tree that had ceased to
# exist, and every other session's suite crawled behind it. The owner watched a six-minute run take
# an hour and asked, reasonably, how we keep ending up here.
#
# It also explains a symptom this repo has been mis-diagnosing for days. `vitest.config.ts` carries a
# long note concluding that the thing starving booting workers is *another session's `astro check`*.
# That is real but it is not the whole of it — an orphan is worse, because a live session's check
# ends and an orphan does not, and because nobody is watching an orphan to notice it is there.
# `verify` then reports "red with no failing test", retries once, and the retry competes with the
# same ghost. Its own guard is what makes this survivable and also what makes it invisible.
#
# ── What it does ──
#
# For every running `vitest`, the worktree path is right there in the absolute path of the binary
# being executed (`…/.claude/worktrees/<name>/node_modules/.bin/vitest`). If that directory is gone,
# the run cannot produce a meaningful answer for anybody, so the whole process group goes.
#
# Deliberately NOT killing anything whose directory still exists — a slow neighbour is a legitimate
# neighbour, and the worker budget in `scripts/lib/test-concurrency.mjs` is how those are handled.
# The only thing this reaps is provably dead.
set -uo pipefail

# ── The decision, as a function, so it can be tested without spawning anything ──
#
# It has to be: this sandbox KILLS any process called `vitest` that `npm run verify` did not start
# (`one-way-to-verify.sh` is the visible half of that rule), so a test that spawns a fake one is
# measuring the sandbox and not this hook. Two runs of exactly that test reported a failure this
# hook never had. Feeding argv strings in and reading a verdict out has no such problem.
#
# Echoes the dead worktree path when the argv belongs to a run whose worktree is gone, and nothing
# at all otherwise. `tests/reap-orphan-verify.test.ts` is the caller.
orphan_worktree_of() {
  local args=$1 wt
  case "$args" in *node_modules/.bin/vitest*) ;; *) return 0 ;; esac
  # By TRUNCATION, not by a regex, and the difference is the whole safety of this hook. The first
  # version matched `.*\(/.*/\.claude/worktrees/[^/]*\)` — and `.*` is greedy, so it began the
  # capture at the LAST `/` it could and returned a path fragment instead of the path. A fragment
  # never exists on disk, so every running vitest looked like an orphan and the hook would have
  # killed LIVE runs across every session.
  #
  # Truncating at a fixed literal cannot mis-anchor. Paths here contain spaces ("תיק עבודות",
  # "porject 2"), so nothing may split this on whitespace either.
  wt=${args%%/node_modules/.bin/vitest*}
  wt=/${wt#*/}                      # drop the interpreter argv[0] ("node ") before the path
  case "$wt" in */.claude/worktrees/*) ;; *) return 0 ;; esac
  [ -d "$wt" ] && return 0
  printf '%s' "$wt"
}

# Sourced by the test, which wants the function and not the sweep.
[ "${REAP_DECIDE_ONLY:-}" = "1" ] && return 0 2>/dev/null

reaped=0
names=""

while IFS= read -r line; do
  pid=${line%% *}
  args=${line#* }
  wt=$(orphan_worktree_of "$args")
  [ -n "$wt" ] || continue

  # ── The PARENT CHAIN, never the process group ──
  #
  # Killing the leaf alone just makes `verify.mjs` report a failed worker and retry into the same
  # hole, so the runner above it has to go too. The obvious way to get all of them — `kill -PGID` —
  # was tried first and is WRONG: several runs can share a process group, and the test written for
  # this hook caught it killing a perfectly live neighbour on its first outing.
  #
  # So: walk up from the vitest process and kill each ancestor only while it still looks like the
  # runner that spawned it. The moment a parent is something else (a shell, the harness, pid 1),
  # stop. That cannot reach sideways into anybody else's run.
  cur=$pid
  for _ in 1 2 3 4; do
    [ -n "$cur" ] && [ "$cur" != "1" ] || break
    parent=$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' ')
    kill -TERM "$cur" 2>/dev/null
    [ -n "$parent" ] && [ "$parent" != "1" ] || break
    pcmd=$(ps -o command= -p "$parent" 2>/dev/null)
    case "$pcmd" in
      *verify.mjs*|*"npm run verify"*|*node_modules/.bin/vitest*) cur=$parent ;;
      *) break ;;
    esac
  done
  reaped=$((reaped + 1))
  names="$names ${wt##*/}"
done < <(pgrep -af 'node_modules/\.bin/vitest' 2>/dev/null || true)

if [ "$reaped" -gt 0 ]; then
  echo "Reaped $reaped orphaned test run(s) from removed worktree(s):$names"
  echo "A session removed its worktree while its own verify was still running inside it. The"
  echo "process kept holding test workers and slowing every other session down. Nothing to do —"
  echo "this is the note, not a question."
fi
exit 0
