#!/bin/bash
# PreToolUse(Edit|Write) — the later session in a shared checkout cannot edit code there. Blocked,
# not requested.
#
# `one-session-per-tree.sh` has said this at SessionStart since 2026-08-04, and on 2026-08-09 five
# sessions were live in the main checkout at once, all of them having read that message. The result
# was the day this hook was written: sessions overwriting each other's uncommitted files, a review
# gate firing on a neighbour's half-finished feature, and a test run whose file count changed between
# collection and execution because another session was creating and deleting files underneath it.
# None of that is a subtle failure — but every one of it was invisible to the session causing it.
#
# The owner's objection is the reason this is a hook and not a better message ("איך אני אמור לוודא?
# זה משהו שאתה אמור להחליט אם הוא נחוץ"): verifying that each session moved out of the shared tree is
# not something he should be doing, and a rule that depends on every session choosing to follow it is
# not a mechanism. He is right, and the evidence is that the advisory version failed five times in
# one day.
#
# WHO gets blocked, because blocking both sides would deadlock the tree instead of freeing it: the
# session that arrived LATER. `one-session-per-tree.sh` already records a start timestamp per PID
# under the per-tree state dir, so "am I the incumbent or the newcomer" is answerable exactly. The
# incumbent keeps working in the shared checkout, which is normal and correct; the newcomer is the
# one the project instruction was always addressed to.
#
# WHAT is blocked is code only — src, tests, migrations, scripts, public. Deliberately still allowed:
#   • .md anywhere. Notes, checklists and CURRENT_TASK are not what collides, and a session that
#     cannot write down what it found is worse than one sharing a tree.
#   • .claude/** — including this file. A gate you cannot repair from inside the situation it creates
#     is a trap, and the session most likely to need to fix it is the one it is blocking.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$DIR/review-state.sh"   # REPO_ROOT + STATE_DIR, keyed per working tree

payload="$(cat 2>/dev/null || true)"

# Edit/Write hand over a file_path. Bash does not, and on 2026-08-18 that was the whole gap: the
# harness had begun making file changes through Bash (`sed -i`, a python heredoc, a `>` redirect),
# this hook was registered for Edit|Write only, and so the newcomer edited the shared checkout all
# session with the guard never firing once. A parallel session's merge then took the uncommitted
# work with it. The rule was never wrong; it was watching two of the three doors.
#
# For Bash there is no path to read, so the command TEXT is the evidence: a repo code path plus
# something write-shaped. It over-triggers by design — a read-only python heredoc that happens to
# name a src/ file is refused too — because the two outcomes are not symmetric. A false positive
# costs one worktree; a false negative costs somebody's uncommitted work, which is what this file
# was written after.
f="$(printf '%s' "$payload" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("file_path","") or "")
except Exception: print("")' 2>/dev/null || echo "")"

if [ -z "$f" ]; then
  cmd="$(printf '%s' "$payload" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command","") or "")
except Exception: print("")' 2>/dev/null || echo "")"
  [ -n "$cmd" ] || exit 0
  # A code path anywhere in the command, ignoring any .md target (same carve-out as below).
  printf '%s' "$cmd" | grep -Eq '(^|[^A-Za-z0-9_./-])(src|tests|migrations|scripts|public)/' || exit 0
  # ...and a write-shaped token. `git checkout/restore/reset/stash/clean` are here because
  # destroying the newcomer's OWN edits in a shared tree is the same collision from the other side.
  #
  # A BARE `>` was the first version of this and it was too blunt to survive its own commit: the
  # commit message describing the fix contained the words "a > redirect", so the hook refused the
  # commit that installed it. Prose is most of what a long Bash command holds — messages, comments,
  # heredoc text — so a token that also appears in English cannot be the test. A redirect only
  # counts when it points AT a code path, which is the thing being claimed anyway.
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?'"'"'?[A-Za-z0-9_./-]*(src|tests|migrations|scripts|public)/|sed[[:space:]]+-i|[[:space:]]tee[[:space:]]|(^|[[:space:];&|])(cp|mv|rm|install|truncate|patch)[[:space:]]|git[[:space:]]+(apply|checkout|restore|reset|stash|clean)([[:space:]]|$)|\.write\(|writeFileSync|open\([^)]*,[[:space:]]*.[wa]' || exit 0
  # Stand in for the file so the code-path test below reads the same for both shapes.
  f="$REPO_ROOT/src/.bash-write"
fi
[ -n "$f" ] || exit 0


# A linked worktree is the answer, not the problem — it has its own gates and its own fingerprint.
git_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-dir 2>/dev/null)" || exit 0
common_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
[ "$git_dir" = "$common_dir" ] || exit 0

# Only code. A path outside the repo is somebody else's business entirely.
case "$f" in
  "$REPO_ROOT"/src/*|"$REPO_ROOT"/tests/*|"$REPO_ROOT"/migrations/*|"$REPO_ROOT"/scripts/*|"$REPO_ROOT"/public/*) ;;
  *) exit 0 ;;
esac
case "$f" in *.md) exit 0 ;; esac

SESSIONS="$STATE_DIR/sessions"
[ -d "$SESSIONS" ] || exit 0

now=$(date +%s)
mine=$PPID
my_start="$(cat "$SESSIONS/$mine" 2>/dev/null || echo "$now")"
earlier=0

for entry in "$SESSIONS"/*; do
  [ -e "$entry" ] || continue
  pid="$(basename "$entry")"
  [ "$pid" = "$mine" ] && continue
  started="$(cat "$entry" 2>/dev/null || echo 0)"
  # Same pruning rule as one-session-per-tree.sh: a dead PID, or an entry old enough that a reused
  # PID is likelier than a session open for half a day. `ps -p`, never `kill -0`.
  if ! ps -p "$pid" -o pid= >/dev/null 2>&1 || [ $((now - started)) -gt 43200 ]; then
    rm -f "$entry"
    continue
  fi
  # Strictly earlier, with the PID as the tie-break, so of any two sessions exactly one is "later"
  # and the tree can never block everybody in it.
  if [ "$started" -lt "$my_start" ] || { [ "$started" -eq "$my_start" ] && [ "$pid" -lt "$mine" ]; }; then
    earlier=$((earlier + 1))
  fi
done

[ "$earlier" -gt 0 ] || exit 0

python3 - "$earlier" <<'PY'
import json, sys
n = sys.argv[1]
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            f"{n} Claude session(s) were already working in this checkout before you, so editing code "
            "here overwrites files somebody is holding open and fails their gates on work they do not "
            "own. That happened five times on 2026-08-09, which is why this is refused rather than "
            "suggested.\n\n"
            "Do this now, without asking the user — it IS the project instruction "
            "(AI_INSTRUCTIONS Workflow §4):\n"
            "  1. EnterWorktree\n"
            "  2. npm run worktree:setup   ← first command inside it; a fresh checkout has no "
            "node_modules or .env\n"
            "Then make this same edit there, and say what has to be merged back when the work is done.\n\n"
            "Still allowed here without a worktree: any .md, and anything under .claude/ — notes and "
            "the hooks themselves are not what collides."
        ),
    }
}))
PY
exit 0
