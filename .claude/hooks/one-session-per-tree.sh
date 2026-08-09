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
# LIVE MEANS WORKING, NOT MERELY RUNNING (rewritten 2026-08-09, and this is the whole point of the
# file now). The first version answered "is that PID alive?" — and in VS Code every session tab left
# open is a live `claude` process forever. Measured over 2026-08-04→09: **34 of 34 sessions were told
# another session was live, and 26 of them opened a worktree for it.** The "other session" at the
# time of the measurement was a tab idle for 1 day 15 hours. So the check that exists to catch a rare
# collision was firing on every single session, and the ~2-minute worktree it prescribes (setup +
# merge back + a tree that must not be left orphaned) was being paid ~26 times a week for nothing.
#
# A session that is actually working appends to its transcript continuously, so freshness of the
# transcript — not existence of the process — is what "live" means here. An entry now records the
# PID and that session's transcript path (the hook's own stdin JSON carries it), and another session
# counts only when its process is alive AND its transcript moved within IDLE_SECS. Both halves are
# required: a fresh transcript with a dead process is a crashed session, and a live process with a
# cold transcript is an abandoned tab.
#
# The error direction is unchanged in the case that matters. Two sessions genuinely working in one
# tree touch their transcripts every few seconds, so they still see each other — that is the
# deadlock this file exists to prevent and it is detected exactly as before. What is no longer
# reported is an idle tab, which cannot void a fingerprint because it is not writing anything. If
# that tab wakes up, its own SessionStart fires again (source `resume`) and it re-registers, so the
# pair is still caught — from the other side, which is the same answer.
set -uo pipefail

payload="$(cat 2>/dev/null || true)"   # the hook's stdin JSON — transcript_path is in here

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

# transcript_path out of the hook's stdin JSON. python3 rather than a regex because the path is a
# JSON string (this repo lives under a directory with non-ASCII characters, which JSON escapes).
my_transcript=""
if [ -n "$payload" ]; then
  my_transcript="$(printf '%s' "$payload" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("transcript_path","") or "")
except Exception: print("")' 2>/dev/null || echo "")"
fi

for entry in "$SESSIONS"/*; do
  [ -e "$entry" ] || continue
  pid="$(basename "$entry")"
  [ "$pid" = "$mine" ] && continue

  # Dead process. `ps -p`, not `kill -0`: kill reports EPERM (i.e. "dead") for a live process owned
  # by anyone else, which is never true of a Claude session but is exactly the kind of quiet false
  # negative this hook exists to avoid.
  if ! ps -p "$pid" -o pid= >/dev/null 2>&1; then
    rm -f "$entry"
    continue
  fi

  # Alive — but is it WORKING? `session_last_seen` (review-state.sh) answers with the later of the
  # Stop-hook heartbeat and the session's own transcript. An idle entry is NOT pruned: the process
  # is alive and may come back, and then its own next stamp is what makes it live again.
  [ $((now - $(session_last_seen "$entry"))) -le "$SESSION_IDLE_SECS" ] && others=$((others + 1))
done

printf '%s\n%s\n' "$now" "$my_transcript" > "$SESSIONS/$mine"

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
