#!/bin/bash
# SessionStart — report every linked worktree that still holds work, so a parallel session can
# never quietly become a fork of the project.
#
# Why this exists. one-session-per-tree.sh routes the 2nd, 3rd, Nth session OUT of the shared tree
# and into a worktree of its own, which is what makes working on several things at once safe. But
# it creates the opposite risk, and the owner named it before it ever happened (2026-08-04): a
# worktree whose branch never gets merged is work that is *in the repo* and *invisible on main* —
# you close the laptop believing a feature shipped, and it is sitting on a branch nobody will look
# at again. AI_INSTRUCTIONS Workflow §4 already says "merge then remove as soon as it's done", and
# a rule you have to remember at exactly the moment you are tired is not a safeguard.
#
# So: every session, in EVERY tree (main or linked), opens with the true state of all of them. You
# do not have to be in the right directory, or remember a worktree exists, to be told about it.
#
# **This is only half of it.** Being told at the start is being told after the fact — the session
# that left the work is the one that knew why, and it is already gone. `worktree-handoff.sh` runs
# the same scan at Stop, so nobody leaves without being asked about it (owner, 2026-08-04). The scan
# itself lives in worktree-scan.sh; both hooks are readings of it.
#
# Quiet when there is nothing to say — no worktrees, or all of them clean and merged. A hook that
# speaks on every session gets skimmed past, and then it is not a safeguard either. The one thing
# it does say about a tidy worktree is that it is safe to delete, because that is how they stop
# accumulating until nobody trusts the list.
set -uo pipefail

cat >/dev/null 2>&1 || true   # drain the hook's stdin JSON

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$DIR/review-state.sh"    # REPO_ROOT
source "$DIR/worktree-scan.sh"   # scan_worktrees

report=""
count=0
while IFS=$'\t' read -r status wt branch detail; do
  [ -n "${status:-}" ] || continue
  count=$((count + 1))
  case "$status" in
    gone)   report+="  • ${wt}  — הספרייה נמחקה; \`git worktree prune\` ינקה את הרישום\n" ;;
    clean)  report+="  ✅ ${wt}\n     [${branch}] נקי וממוזג — אפשר להסיר: ExitWorktree remove\n" ;;
    # Outstanding work with somebody still in the room is the NORMAL state of parallel work, not a
    # problem. Marked, so the list stays complete, but never as something to act on.
    live)   report+="  🔵 ${wt}\n     [${branch}] ${detail} — סשן פעיל, בעבודה. אין מה למזג עכשיו.\n" ;;
    orphan) report+="  ⚠️ ${wt}\n     [${branch}] ${detail} — אין סשן פעיל.\n" ;;
  esac
done <<EOF
$(scan_worktrees "$REPO_ROOT")
EOF

[ "$count" -gt 0 ] || exit 0
[ -n "$report" ] || exit 0

printf 'קיימים %d worktree מלבד העץ הראשי:\n\n' "$count"
printf '%b\n' "$report"
cat <<'EOF'
Tell the user about any ⚠️ line, in Hebrew, in ONE line at the top of your first reply — that is the
whole point of this hook: a worktree with unmerged commits and nobody in it is work that exists in
the repo and is invisible on main, which is exactly what he asked to be protected from.

A 🔵 line is NOT that. It is a session working right now, and mid-task work is supposed to be
unmerged — mention it only if he asks what is running. Never offer to merge one.

Never merge or remove anything here unprompted: that is his call, and on a 🔵 tree it would land on
top of somebody's unfinished work.

The state can change while you work — another session may merge and remove a worktree mid-turn. Re-run
`git worktree list` before telling the user a worktree still needs a decision.
EOF
