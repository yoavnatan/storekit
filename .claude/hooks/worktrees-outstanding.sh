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
# Quiet when there is nothing to say — no worktrees, or all of them clean and merged. A hook that
# speaks on every session gets skimmed past, and then it is not a safeguard either. The one thing
# it does say about a tidy worktree is that it is safe to delete, because that is how they stop
# accumulating until nobody trusts the list.
set -uo pipefail

cat >/dev/null 2>&1 || true   # drain the hook's stdin JSON

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$DIR/review-state.sh"   # REPO_ROOT

# The integration branch every worktree is measured against. Not `origin/main`: a branch that is
# merged locally but not yet pushed is finished work, not outstanding work, and flagging it would
# train you to ignore the report. Pushing is the push gate's job, not this one's.
BASE=main

# --porcelain is the only stable form: a path may contain spaces (this repo lives under one) and the
# human format cannot be parsed for them. Read in a plain `while read` loop and NOT via `mapfile`:
# macOS ships bash 3.2, where mapfile does not exist and the hook died on its first line.
# The loop runs in this shell (input redirected at `done`, not piped) so `paths` survives it.
wt_list="$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null)" || exit 0

main_tree=""
paths=()
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      p="${line#worktree }"
      # The FIRST entry git reports is the main working tree; the rest are the linked ones this
      # hook is about. A linked worktree has its own checkout but shares the object store.
      if [ -z "$main_tree" ]; then main_tree="$p"; else paths=("${paths[@]:-}" "$p"); fi
      ;;
  esac
done <<EOF
$wt_list
EOF

# `paths=("${paths[@]:-}" …)` above seeds an empty first element under bash 3.2's nounset rules;
# drop it so the count is the real number of linked worktrees.
[ "${#paths[@]}" -gt 0 ] && [ -z "${paths[0]}" ] && paths=("${paths[@]:1}")
[ "${#paths[@]}" -gt 0 ] || exit 0

# Is a Claude session live in this worktree right now?
#
# This is the difference between "you left work behind" and "someone is typing in there", and
# without it the report is actively wrong during exactly the situation it was built for — three
# sessions at once, all of them mid-task, none of them ready to merge (owner, 2026-08-04).
# one-session-per-tree.sh already registers each session's PID under the state dir of ITS OWN tree,
# and that dir is keyed by a hash of the tree path (review-state.sh), so the same key can be
# recomputed here for any other worktree. Same liveness test as that hook, for the same reasons:
# `ps -p` rather than `kill -0`, and an entry older than 12h is treated as a reused PID.
session_live_in() {
  local tree="$1" dir pid started now
  dir="/tmp/claude-review-state-$(printf '%s' "$tree" | shasum | cut -d' ' -f1)/sessions"
  [ -d "$dir" ] || return 1
  now=$(date +%s)
  for entry in "$dir"/*; do
    [ -e "$entry" ] || continue
    pid="$(basename "$entry")"
    started="$(cat "$entry" 2>/dev/null || echo 0)"
    ps -p "$pid" -o pid= >/dev/null 2>&1 || continue
    [ $((now - started)) -gt 43200 ] && continue
    return 0
  done
  return 1
}

report=""
for wt in "${paths[@]}"; do
  # A directory that has been deleted by hand leaves a registration behind; `git worktree prune`
  # is the fix, and saying so beats a confusing "not a git repository" further down.
  if [ ! -d "$wt" ]; then
    report+="  • ${wt}  — הספרייה נמחקה; \`git worktree prune\` ינקה את הרישום\n"
    continue
  fi

  branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  dirty_count="$(git -C "$wt" status --porcelain 2>/dev/null | grep -c . || true)"
  # Commits on this worktree's branch that $BASE cannot reach — i.e. work that would vanish from
  # the project's history if the worktree were removed now.
  unmerged_count="$(git -C "$wt" log --oneline "$BASE..HEAD" 2>/dev/null | grep -c . || true)"

  detail=""
  [ "${unmerged_count:-0}" -gt 0 ] && detail+="${unmerged_count} קומיטים שלא מוזגו ל-${BASE}"
  if [ "${dirty_count:-0}" -gt 0 ]; then
    [ -n "$detail" ] && detail+=" · "
    detail+="${dirty_count} קבצים לא מקומיטים"
  fi

  if [ -z "$detail" ]; then
    report+="  ✅ ${wt}\n     [${branch}] נקי וממוזג — אפשר להסיר: ExitWorktree remove\n"
  elif session_live_in "$wt"; then
    # Outstanding work with somebody still in the room is the NORMAL state of parallel work, not a
    # problem. Marked, so the list stays complete, but never as something to act on.
    report+="  🔵 ${wt}\n     [${branch}] ${detail} — סשן פעיל, בעבודה. אין מה למזג עכשיו.\n"
  else
    report+="  ⚠️ ${wt}\n     [${branch}] ${detail} — אין סשן פעיל.\n"
  fi
done

[ -n "$report" ] || exit 0

printf 'קיימים %d worktree מלבד העץ הראשי:\n\n' "${#paths[@]}"
printf '%b\n' "$report"
cat <<'EOF'
Tell the user about any ⚠️ line, in Hebrew, in ONE line at the top of your first reply — that is the
whole point of this hook: a worktree with unmerged commits and nobody in it is work that exists in
the repo and is invisible on main, which is exactly what he asked to be protected from.

A 🔵 line is NOT that. It is a session working right now, and mid-task work is supposed to be
unmerged — mention it only if he asks what is running. Never offer to merge one.

Never merge or remove anything here unprompted: that is his call, and on a 🔵 tree it would land on
top of somebody's unfinished work.
EOF
