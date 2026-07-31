#!/bin/bash
# Stop hook — the turn does not end on red.
#
# `astro check`, `npm run lint` and `npm test` were documented in AI_INSTRUCTIONS.md as "run after
# every code step", which made them a reminder rather than a rule. The /code-review gate taught the
# lesson: an instruction that reads like diligence and enforces nothing is worse than no instruction,
# because it makes the gap invisible. So this enforces it.
#
# Two costs are managed rather than ignored:
#   • Running them is delegated to `scripts/verify.mjs --all`, which runs them concurrently and warm
#     off their own caches (~40s, against ~115s serial and uncached).
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

cd "$REPO_ROOT" || exit 0

# `scripts/verify.mjs` owns the running: concurrent, cached, and it formats its own failure output.
# The hook keeps only what is its own — the fingerprint, the attempt bound, the block decision. Two
# copies of "how do I run the checks" is how the gate and the checkpoint drift apart.
# --all, never the scoped default: a check skipped because its file was committed earlier in the
# session is still a check that did not run, and this is the last gate before the turn ends.
failed="$(node scripts/verify.mjs --all --compact 2>&1)"
rc=$?

if [ "$rc" = "0" ]; then
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
