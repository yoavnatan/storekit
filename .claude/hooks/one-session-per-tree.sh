#!/bin/bash
# SessionStart — the second session in a working tree is told to move out of it, without the user
# having to notice or say anything.
#
# Why a hook and not a rule. AI_INSTRUCTIONS Workflow §4 already says "a worktree each, always", but
# a session cannot obey it: nothing in a fresh context reveals that ANOTHER session is live in the
# same tree, and the user should not have to remember to say so. The instruction only becomes
# reachable if something tells the session which one it is. That is all this does.
#
# What it is preventing (measured 2026-08-04, and the user hit it repeatedly). Every gate here keys
# off a fingerprint of the WHOLE working tree — verify.mjs's content hash, review-state.sh's
# diff_fingerprint. So the two sessions do NOT have to share a file, or even a directory: the other
# one's save voids your verify cache, resets require-green.sh's `red-$fp` attempt counter to zero so
# its escape hatch never fires, and turns `--all` red on half-written code you cannot fix. Each turn
# then opens a fresh gate on a fresh fingerprint and never ends. "Our tasks don't overlap" was the
# belief that made this look impossible; the fingerprint is the tree, not your files.
#
# RE-MEASURED 2026-08-09, AFTER THE OWNER ASKED WHY A WORKTREE EVERY TIME — AND THE DUMB RULE WON.
# The suspicion was reasonable and the fix was written before it was checked: in VS Code a session
# tab left open is a live `claude` process for days, so "the PID exists" looked like it would fire on
# abandoned tabs and charge ~2.5 min of worktree setup for nothing. It does not. Every session's
# transcript in ~/.claude/projects carries a timestamp per event, so overlap is measurable directly:
# of the 40 sessions started 2026-08-04→09, **40 had another session emitting events between their
# start and their last event** — genuinely concurrent, every time. An "active within 15 minutes"
# rule would have been WORSE, not better: it answers yes for only 36 of those 40, and the 4 it drops
# are the neighbour that goes quiet, then resumes — which is exactly the deadlock this file exists to
# prevent, reintroduced to save a worktree the session needed anyway. The activity version was built,
# tested and reverted the same session. Don't rebuild it; re-run the overlap measurement first.
#
# Liveness, kept deliberately dumb. Each session registers the PID that spawned this hook (its own
# Claude process) under the per-tree state dir, and entries are pruned when that PID is gone or the
# clock says the machine has since rebooted into a reused PID. A wrong answer is possible in exactly
# one direction — an extra worktree nobody needed, which costs ~2 minutes and no correctness. The
# other direction, missing a live session, is what this exists to stop, so it errs toward speaking up.
set -uo pipefail

cat >/dev/null 2>&1 || true   # drain the hook's stdin JSON

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$DIR/review-state.sh"   # REPO_ROOT + STATE_DIR, already keyed per working tree

# A linked worktree has its own REPO_ROOT and therefore its own STATE_DIR and its own gates — it is
# the answer, not the problem. Nothing to say there.
git_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-dir 2>/dev/null)" || exit 0
common_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
[ "$git_dir" = "$common_dir" ] || exit 0

SESSIONS="$STATE_DIR/sessions"
mkdir -p "$SESSIONS" 2>/dev/null || exit 0

now=$(date +%s)
mine=$PPID

# The CWD of a live process, or empty.
#
# **Registered here and WORKING here stopped being the same sentence** the day worktrees became
# routine (found 2026-08-20). A session registers its PID once, at SessionStart, in the tree it
# started in — and `EnterWorktree` moves the session without moving the entry. So this hook was
# reading "three others registered in main" and reporting them as three others IN main, when all
# three had been in their own worktrees for hours. That is a false positive in the expensive
# direction: the new session is sent to build a worktree it does not need — ~2.5 min of `npm ci`,
# plus a checkout whose tree hash matches nobody, so it shares no verify marker with any session
# alive. Exactly the waste the owner was asking about when he asked what verify was costing him.
#
# `lsof -d cwd` is the only handle macOS gives on another process's working directory. It costs
# ~100ms per PID over at most a handful of them, well inside this hook's 15s.
cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

# **A machine-wide session ceiling was written here on 2026-08-20 and deleted the same hour.** It
# warned above two live sessions, on a diagnosis that turned out to be wrong: the cost was never the
# session count. It was `verify` serialising every suite behind one machine-wide lock, on a machine
# with six physical cores that every worker cap had been sized against as though it had twelve — see
# `scripts/lib/test-concurrency.mjs`, where both are fixed. The owner's requirement is that more than
# two sessions must work. A hook nagging about a third would be arguing with him about a number that
# was not the cause. Don't re-add it; fix whatever is making a session expensive instead.
here=0
for entry in "$SESSIONS"/*; do
  [ -e "$entry" ] || continue
  pid="$(basename "$entry")"
  started="$(cat "$entry" 2>/dev/null || echo 0)"
  # Dead process, or an entry old enough that a reused PID is the likelier explanation than a session
  # that has been open for half a day. `ps -p`, not `kill -0`: kill reports EPERM (i.e. "dead") for a
  # live process owned by anyone else, which is never true of a Claude session but is exactly the
  # kind of quiet false negative this hook exists to avoid.
  if ! ps -p "$pid" -o pid= >/dev/null 2>&1 || [ $((now - started)) -gt 43200 ]; then
    rm -f "$entry"
    continue
  fi
  [ "$pid" = "$mine" ] && continue
  [ "$(cwd_of "$pid")" = "$REPO_ROOT" ] && here=$((here + 1))
done

echo "$now" > "$SESSIONS/$mine"

[ "$here" -gt 0 ] || exit 0

cat <<EOF
⚠️ $here other Claude session(s) are live in THIS working tree, and you are the later one.

Two sessions in one tree deadlock — not because you might edit the same files (you probably won't),
but because every gate keys off a fingerprint of the whole tree, so their keystroke voids your verify
cache, resets require-green.sh's attempt bound, and fails you on code you don't own. The turn then
never ends. AI_INSTRUCTIONS Workflow §4 is the rule; this is you being told it applies to you.

Before your first edit, and without asking the user (this IS the project instruction):
  1. EnterWorktree
  2. npm run worktree:setup     ← first command inside it; a checkout has no node_modules/.env
Then do the work there, and when it is done say what has to be merged back.
EOF
