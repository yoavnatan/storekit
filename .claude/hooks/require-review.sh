#!/bin/bash
# Stop hook — makes the review happen automatically, without the user having to ask for it.
#
# The user cannot be expected to remember to request a review, and a hook that only PRINTS a reminder
# gets read after the turn is already over. So this blocks the turn from ending: Claude Code feeds
# `reason` back to the model, which then has to run the review-diff skill before it can finish.
#
# Bounded on purpose. It blocks at most twice for a given diff — after that it lets the turn end with
# a visible warning instead of trapping the session in a loop. An unbounded gate on a Stop hook is how
# a session becomes unusable, and a gate nobody can escape gets disabled entirely, which is worse than
# a gate that occasionally lets one through loudly.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/review-state.sh"

json=$(cat 2>/dev/null || echo '{}')

# Not a git repo, or nothing changed → nothing to review.
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || exit 0
touches_sensitive || exit 0

fp="$(diff_fingerprint)"
mkdir -p "$STATE_DIR" 2>/dev/null

# Already reviewed at exactly this diff.
[ -f "$STATE_DIR/reviewed-$fp" ] && exit 0

attempts_file="$STATE_DIR/blocked-$fp"
attempts=0
[ -f "$attempts_file" ] && attempts=$(cat "$attempts_file" 2>/dev/null || echo 0)

if [ "$attempts" -ge 2 ]; then
  echo '{"systemMessage":"Review gate: gave up after 2 attempts — this diff touches money/auth/inventory and was NOT reviewed. Ask Claude to run the review-diff skill, or run /code-review yourself."}'
  exit 0
fi

echo $((attempts + 1)) > "$attempts_file"

files=$(changed_files | grep -E "$SENSITIVE_RE" | head -12 | tr '\n' ' ')

# `decision: block` + `reason` is the Stop-hook contract: the reason is fed back to the model and the
# turn continues instead of ending.
reason="This diff touches the reviewed surface and has not been reviewed yet: ${files}

Before finishing: invoke the review-diff skill (Skill tool, skill: \"review-diff\"), review the diff hunk by hunk against its checklist, fix what you find, then run 'bash .claude/hooks/record-review.sh' to record it. Report what you checked and what you skipped. Do not skip this and do not claim /code-review ran — it cannot be model-invoked."

python3 - "$reason" <<'PY'
import json, sys
print(json.dumps({"decision": "block", "reason": sys.argv[1]}))
PY
