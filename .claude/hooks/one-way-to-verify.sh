#!/bin/bash
# PreToolUse(Bash) — `npm run verify` is the only way these checks run. Enforced, not remembered.
#
# AI_INSTRUCTIONS.md → Hard rules → Testing has said "never run `astro check`, `tsc` or a whole
# `vitest run` by hand" since 2026-08-03. Measured over 2026-08-04→09 across every session in this
# repo: **67 hand-run `astro check` / `tsc` invocations, 41 minutes**, all of it duplicating a check
# `npm run verify` had just run or was about to. That is the signature of a rule that reads like
# diligence and enforces nothing — the same lesson require-review.sh and require-green.sh were built
# on, so it gets the same treatment.
#
# What this actually saves is not one command. verify runs the checks CONCURRENTLY and skips any
# whose inputs are byte-identical to the last time they passed, so the hand-run copy is not "the
# same check a bit earlier" — it is the same check again, uncached, serialised, on a box whose cores
# vitest is already using (why a full checkpoint is CPU-bound: scripts/verify.mjs's header).
#
# Deliberately NOT blocked:
#   • A single test file — `vitest run tests/foo.test.ts` — which the rule explicitly allows while
#     iterating. Only a whole-suite run is the duplicate.
#   • `npm run lint` on its own: it is 8s, it is the documented way to confirm a phantom cached lint
#     error (verify.mjs's header), and it was never part of the measured waste.
#   • Anything inside scripts/verify.mjs itself — it spawns node_modules/.bin binaries directly, not
#     through bash, so it never reaches this hook.
set -uo pipefail

payload="$(cat 2>/dev/null || true)"

cmd="$(printf '%s' "$payload" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command","") or "")
except Exception: print("")' 2>/dev/null || echo "")"

[ -n "$cmd" ] || exit 0

# `npm run verify …` is the sanctioned wrapper; let it through whatever it contains.
printf '%s' "$cmd" | grep -Eq 'run +verify' && exit 0

deny() {
  python3 - "$1" <<'PY'
import json, sys
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": sys.argv[1],
    }
}))
PY
  exit 0
}

# Type checking, by any spelling.
if printf '%s' "$cmd" | grep -Eq '(^|[;&|] *)(npx +)?(astro +check|tsc)\b|astro/tsconfigs|node_modules/\.bin/(astro|tsc)'; then
  deny "Run \`npm run verify\` instead of a hand-run type check. It runs astro check / tsc / lint / tests concurrently, off their caches, and skips whatever is byte-identical to the last pass — a hand-run \`astro check\` is 84s of the same answer. \`npm run verify -- --all\` forces every check; \`--no-cache\` forces them to actually re-run."
fi

# A whole-suite test run. A single file (or a -t filter) stays allowed.
if printf '%s' "$cmd" | grep -Eq '(^|[;&|] *)(npx +)?vitest +run *([;&|]|$)|(^|[;&|] *)npm +(run +)?test *([;&|]|$)'; then
  deny "Run \`npm run verify\` instead of the whole test suite by hand — it runs the same vitest pass concurrently with the other checks and skips it entirely when nothing it reads has changed. A SINGLE file (\`npx vitest run tests/foo.test.ts\`) is still fine while iterating."
fi

exit 0
