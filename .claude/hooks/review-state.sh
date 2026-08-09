#!/bin/bash
# Shared by require-review.sh (Stop) and record-review.sh (called by the review-diff skill).
#
# Both need the same two answers: what does the current working diff look like, and does it touch the
# surface that has to be reviewed. Keeping them in one file is the point — if the two scripts computed
# the fingerprint differently, a recorded review would never match the review being demanded, and the
# hook would block forever.
set -uo pipefail

# Must be the git TOPLEVEL, not just the parent directory. `ls-files --others` is scoped to the
# directory git is invoked from, so pointing this at `.claude/` silently limited untracked-file
# detection to that one folder — the gate looked like it worked because tracked changes are found
# from anywhere.
# `${BASH_SOURCE[0]:-$0}`: the hooks always run under bash, but this file also gets sourced by hand
# when debugging, and in zsh BASH_SOURCE is unset — which under `set -u` aborts with a confusing
# "parameter not set" instead of resolving the repo.
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(git -C "$HOOKS_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$HOOKS_DIR")"

# Per-repo, per-boot. /tmp rather than the repo so nothing to gitignore and no state survives a
# reboot — a review is only meaningful against the diff it actually read.
STATE_DIR="/tmp/claude-review-state-$(printf '%s' "$REPO_ROOT" | shasum | cut -d' ' -f1)"

# The surface AI_INSTRUCTIONS.md → "Security review gate" names, plus inventory and the reporting
# modules that decide what counts as revenue.
SENSITIVE_RE='(orders|seller-|seller/|cart|user-carts|checkout|payment|auth|store-products|money|admin-stats|reconcile|pricing|discounts|balances)'

# Tracked changes AND untracked files — much of this repo's work is uncommitted, so a diff against
# HEAD alone misses whole new modules.
changed_files() {
  {
    git -C "$REPO_ROOT" diff HEAD --name-only 2>/dev/null
    git -C "$REPO_ROOT" ls-files --others --exclude-standard 2>/dev/null
  } | sort -u
}

# Exact content fingerprint: the tracked diff plus a real hash of every untracked file. File size or
# mtime would let a same-length edit reuse a stale review.
diff_fingerprint() {
  {
    git -C "$REPO_ROOT" diff HEAD 2>/dev/null
    while IFS= read -r f; do
      [ -f "$REPO_ROOT/$f" ] && git -C "$REPO_ROOT" hash-object "$f" 2>/dev/null
    done < <(git -C "$REPO_ROOT" ls-files --others --exclude-standard 2>/dev/null)
  } | shasum | cut -d' ' -f1
}

touches_sensitive() {
  changed_files | grep -Eq "$SENSITIVE_RE"
}

# ── Is another session LIVE in a tree? ───────────────────────────────────────────────────────────
#
# One definition, because three hooks ask the question and a disagreement between them is a silent
# wrong answer: one-session-per-tree.sh (should I move to a worktree?), worktree-scan.sh /
# worktree-handoff.sh (is somebody working in that tree, or is it forgotten?).
#
# A session registers `$STATE_DIR/sessions/<pid>` holding a last-seen timestamp on line 1 and, when
# it is known, its transcript path on line 2. Live means the process is alive AND one of those two
# moved within SESSION_IDLE_SECS — a Stop-hook heartbeat every turn, or the transcript itself, which
# a working session appends to continuously. Before 2026-08-09 the only question was whether the PID
# existed, and in VS Code a tab left open is a live `claude` process for days: the check fired on
# every session in the repo and each one paid ~2.5 min for a worktree it did not need.
# 15 minutes: a working session stamps itself at every turn end and appends to its transcript on
# every tool result, so seconds would do — the slack is for a long build or a user reading. Raise it
# and idle tabs come back; lower it and a session waiting on a slow command reads as gone.
SESSION_IDLE_SECS=900

session_last_seen() {
  local entry="$1" stamp transcript mt
  stamp="$(sed -n 1p "$entry" 2>/dev/null || echo 0)"
  case "$stamp" in (*[!0-9]*|'') stamp=0 ;; esac
  transcript="$(sed -n 2p "$entry" 2>/dev/null || echo '')"
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    mt="$(stat -f %m "$transcript" 2>/dev/null || stat -c %Y "$transcript" 2>/dev/null || echo 0)"
    [ "$mt" -gt "$stamp" ] 2>/dev/null && stamp="$mt"
  fi
  printf '%s' "$stamp"
}

# 0 = a session is live in $1 (a working-tree path). Never prunes: this is the read-only question.
session_live_in() {
  local dir entry pid now
  dir="/tmp/claude-review-state-$(printf '%s' "$1" | shasum | cut -d' ' -f1)/sessions"
  [ -d "$dir" ] || return 1
  now=$(date +%s)
  for entry in "$dir"/*; do
    [ -e "$entry" ] || continue
    pid="$(basename "$entry")"
    ps -p "$pid" -o pid= >/dev/null 2>&1 || continue
    [ $((now - $(session_last_seen "$entry"))) -le "$SESSION_IDLE_SECS" ] && return 0
  done
  return 1
}
