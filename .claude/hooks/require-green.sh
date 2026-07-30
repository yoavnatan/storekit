#!/bin/bash
# Stop hook — the turn does not end on red.
#
# `astro check`, `npm run lint` and `npm test` were documented in AI_INSTRUCTIONS.md as "run after
# every code step", which made them a reminder rather than a rule. The /code-review gate taught the
# lesson: an instruction that reads like diligence and enforces nothing is worse than no instruction,
# because it makes the gap invisible. So this enforces it.
#
# Two costs are managed rather than ignored:
#   • Serially the three take ~106s. Run concurrently they take about as long as the slowest (~40s).
#   • Re-running them when nothing changed is pure waste, so a successful run is recorded against the
#     same content fingerprint the review gate uses. A turn that changed no code exits instantly.
#
# Bounded like the review gate: at most two blocks per fingerprint, then it lets the turn end with a
# visible warning. A gate with no escape hatch gets switched off, and then it protects nothing.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/review-state.sh"

cat >/dev/null 2>&1 || true   # drain the hook's stdin JSON; nothing here needs it

git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Only code can break the build. A docs/memory/config-only turn skips this entirely.
changed_files | grep -Eq '\.(ts|tsx|astro|mjs|js)$' || exit 0

fp="$(diff_fingerprint)"
mkdir -p "$STATE_DIR" 2>/dev/null
[ -f "$STATE_DIR/green-$fp" ] && exit 0

attempts_file="$STATE_DIR/red-$fp"
attempts=0
[ -f "$attempts_file" ] && attempts=$(cat "$attempts_file" 2>/dev/null || echo 0)

if [ "$attempts" -ge 2 ]; then
  echo '{"systemMessage":"Verification gate: gave up after 2 attempts — this turn ends with astro check / lint / tests NOT confirmed green. CI will catch it."}'
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$REPO_ROOT" || exit 0

# Concurrent — they are independent read-only checks.
( npx astro check           >"$TMP/tsc"  2>&1; echo $? >"$TMP/tsc.rc"  ) &
( npm run --silent lint     >"$TMP/lint" 2>&1; echo $? >"$TMP/lint.rc" ) &
( npx vitest run            >"$TMP/test" 2>&1; echo $? >"$TMP/test.rc" ) &
wait

failed=""
# astro check exits non-zero on error; its own summary line is the useful part.
[ "$(cat "$TMP/tsc.rc" 2>/dev/null || echo 1)" != "0" ] && failed="${failed}
--- astro check ---
$(grep -E 'error ts\(|^- [0-9]+ error' "$TMP/tsc" | sed 's/\x1b\[[0-9;]*m//g' | head -12)"
[ "$(cat "$TMP/lint.rc" 2>/dev/null || echo 1)" != "0" ] && failed="${failed}
--- npm run lint (new problems only; the baseline is excluded) ---
$(tail -25 "$TMP/lint")"
[ "$(cat "$TMP/test.rc" 2>/dev/null || echo 1)" != "0" ] && failed="${failed}
--- npm test ---
$(grep -E '✗|×|FAIL|Tests  ' "$TMP/test" | head -15)"

if [ -z "$failed" ]; then
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$STATE_DIR/green-$fp"
  rm -f "$attempts_file"
  exit 0
fi

echo $((attempts + 1)) > "$attempts_file"

python3 - "$failed" <<'PY'
import json, sys
print(json.dumps({
    "decision": "block",
    "reason": "Verification is red — fix this before finishing the turn:"
              + sys.argv[1]
              + "\n\nFix the cause, not the symptom, and do not record a review or claim done while this is red."
}))
PY
