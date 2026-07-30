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
