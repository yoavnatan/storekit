#!/bin/bash
# The state of every linked worktree, as data — sourced by the two hooks that report it.
#
# Split out on 2026-08-04, when the same scan was needed at the END of a session as well as the
# start. The owner's objection was exact: it is not enough that a session is TOLD what the last one
# left behind, because by then the work has already been abandoned — the session that is leaving is
# the only one that still knows why. So `worktrees-outstanding.sh` (SessionStart) and
# `worktree-handoff.sh` (Stop) are two readings of one scan, and this file is the scan.
#
# Deliberately not a second copy of the logic in each hook: the liveness test and the
# "what counts as outstanding" rule are the whole substance here, and this repo's own review
# checklist says a rule living in two modules is the next bug.
#
# Output of `scan_worktrees`: one TAB-separated record per linked worktree —
#   <status>\t<path>\t<branch>\t<detail>
# where status is one of: clean | live | orphan | gone
# `detail` is a Hebrew phrase describing what is outstanding (empty for clean/gone).

# The integration branch every worktree is measured against. Not `origin/main`: a branch merged
# locally but not yet pushed is finished work, not outstanding work, and flagging it would train you
# to ignore the report. Pushing is the push gate's job, not this one's.
WORKTREE_BASE=main

# Is a Claude session live in this worktree right now?
#
# The difference between "you left work behind" and "someone is typing in there" — without it the
# report is actively wrong during the exact situation it was built for: three sessions at once, all
# mid-task, none ready to merge (owner, 2026-08-04). one-session-per-tree.sh registers each session's
# PID under the state dir of ITS OWN tree, keyed by a hash of the tree path (review-state.sh), so the
# same key can be recomputed here for any other worktree. `ps -p` rather than `kill -0`, and an entry
# older than 12h is treated as a reused PID.
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

# Every linked worktree's path, one per line. `--porcelain` is the only stable form: a path may
# contain spaces (this repo lives under one) and the human format cannot be parsed for them. Read in
# a plain `while read` loop and NOT via `mapfile`: macOS ships bash 3.2, where mapfile does not exist
# and the hook died on its first line. The FIRST entry git reports is the main working tree; the rest
# are the linked ones these hooks are about.
worktree_paths() {
  local wt_list line p main_tree=""
  wt_list="$(git -C "$1" worktree list --porcelain 2>/dev/null)" || return 0
  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        p="${line#worktree }"
        if [ -z "$main_tree" ]; then main_tree="$p"; else printf '%s\n' "$p"; fi
        ;;
    esac
  done <<EOF
$wt_list
EOF
}

scan_worktrees() {
  local repo_root="$1" wt branch dirty_count unmerged_count detail
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    # A directory deleted by hand leaves a registration behind; `git worktree prune` is the fix, and
    # saying so beats a confusing "not a git repository" further down.
    if [ ! -d "$wt" ]; then
      printf 'gone\t%s\t?\t\n' "$wt"
      continue
    fi

    branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    dirty_count="$(git -C "$wt" status --porcelain 2>/dev/null | grep -c . || true)"
    # Commits on this worktree's branch that $WORKTREE_BASE cannot reach — work that would vanish
    # from the project's history if the worktree were removed now.
    unmerged_count="$(git -C "$wt" log --oneline "$WORKTREE_BASE..HEAD" 2>/dev/null | grep -c . || true)"

    detail=""
    [ "${unmerged_count:-0}" -gt 0 ] && detail+="${unmerged_count} קומיטים שלא מוזגו ל-${WORKTREE_BASE}"
    if [ "${dirty_count:-0}" -gt 0 ]; then
      [ -n "$detail" ] && detail+=" · "
      detail+="${dirty_count} קבצים לא מקומיטים"
    fi

    if [ -z "$detail" ]; then
      printf 'clean\t%s\t%s\t\n' "$wt" "$branch"
    elif session_live_in "$wt"; then
      printf 'live\t%s\t%s\t%s\n' "$wt" "$branch" "$detail"
    else
      printf 'orphan\t%s\t%s\t%s\n' "$wt" "$branch" "$detail"
    fi
  done <<EOF
$(worktree_paths "$repo_root")
EOF
}
