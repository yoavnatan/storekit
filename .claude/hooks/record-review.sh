#!/bin/bash
# Called by the review-diff skill once a review is actually finished. Marks THIS exact diff as
# reviewed, so the Stop hook lets the turn end.
#
# Keyed to the diff fingerprint, not to the session: change one more line after reviewing and the
# marker no longer matches, so the gate comes back. That is deliberate — a review is only valid for
# the code it read.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/review-state.sh"

git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo — nothing to record"; exit 0; }

fp="$(diff_fingerprint)"
mkdir -p "$STATE_DIR"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$STATE_DIR/reviewed-$fp"
rm -f "$STATE_DIR/blocked-$fp"

echo "Review recorded for the current diff (${fp:0:12}). Editing further code re-arms the gate."
