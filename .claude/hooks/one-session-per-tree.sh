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
others=0

for entry in "$SESSIONS"/*; do
  [ -e "$entry" ] || continue
  pid="$(basename "$entry")"
  [ "$pid" = "$mine" ] && continue
  started="$(cat "$entry" 2>/dev/null || echo 0)"
  # Dead process, or an entry old enough that a reused PID is the likelier explanation than a session
  # that has been open for half a day. `ps -p`, not `kill -0`: kill reports EPERM (i.e. "dead") for a
  # live process owned by anyone else, which is never true of a Claude session but is exactly the
  # kind of quiet false negative this hook exists to avoid.
  if ! ps -p "$pid" -o pid= >/dev/null 2>&1 || [ $((now - started)) -gt 43200 ]; then
    rm -f "$entry"
    continue
  fi
  others=$((others + 1))
done

echo "$now" > "$SESSIONS/$mine"

[ "$others" -gt 0 ] || exit 0

cat <<EOF
⚠️ $others other Claude session(s) are already live in THIS working tree, and you are the later one.

Two sessions in one tree deadlock — not because you might edit the same files (you probably won't),
but because every gate keys off a fingerprint of the whole tree, so their keystroke voids your verify
cache, resets require-green.sh's attempt bound, and fails you on code you don't own. The turn then
never ends. AI_INSTRUCTIONS Workflow §4 is the rule; this is you being told it applies to you.

Before your first edit, and without asking the user (this IS the project instruction):
  1. EnterWorktree
  2. npm run worktree:setup     ← first command inside it; a checkout has no node_modules/.env
Then do the work there, and when it is done say what has to be merged back.
EOF
