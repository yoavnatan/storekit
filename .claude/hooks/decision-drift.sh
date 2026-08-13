#!/bin/bash
# Stop hook. Catches the one failure `tests/instructions-integrity.test.ts` says out loud that it
# cannot: a note in AI_INSTRUCTIONS.md whose PATH is still correct and whose CLAIM has stopped being
# true.
#
# ── The case that caused this (2026-08-13, found by the owner asking a question) ──
# A session decided the platform does NOT issue the buyer's invoice; the seller does, in his own
# name. That session did everything right — it wrote the decision into `lib/invoicing/buyer-invoice.ts`
# ("AFTER the decision that the platform does not issue it"), corrected `terms.astro`, and updated
# GO_LIVE §4. What nobody touched was line 41 of AI_INSTRUCTIONS' always-read part, which still said
# invoices go "seller→buyer for the full order **in the seller's name**". Every automated check
# passed: the path existed, the budget held, the tests were green. A later session then read that
# line, believed it, and wrote a whole audit row on top of it. The owner caught it by asking what it
# meant.
#
# ── Why the existing rule did not fire ──
# AI_INSTRUCTIONS' end-of-session list already says to re-read a module's note and confirm the truth
# in the CODE — but it is scoped to **Project structure** lines, i.e. to the file you edited. A
# DECISION does not change a structure line. It changes a RULE, somewhere else in the document,
# possibly written by a different session months earlier. There was no trigger for that at all.
#
# ── What this checks, and why it is deliberately narrow ──
# Two conditions, both required:
#   1. a line ADDED since the last push declares a decision — the words this repo actually uses when
#      one rule replaces another, not every "owner, <date>" (those are mostly UI preferences and
#      would make this fire on nearly every session, which is how a hook gets ignored);
#   2. the always-read part of AI_INSTRUCTIONS mentions that same module or its directory.
# Both together is the exact shape of the bug above. Either alone is not worth a word.
#
# It never blocks. It cannot know whether the two agree — only a person can — so it names the pair
# and gets out of the way.
set -uo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(git -C "$HOOKS_DIR" rev-parse --show-toplevel 2>/dev/null || echo "")"
[ -z "$REPO_ROOT" ] && exit 0

INSTRUCTIONS="$REPO_ROOT/AI_INSTRUCTIONS.md"
[ -f "$INSTRUCTIONS" ] || exit 0

# The words that mean "a previous rule is now wrong". Kept short on purpose — see the note above on
# why "owner, <date>" is not on this list.
DECISION_RE='supersede|superseded|AFTER the decision|replaces the rule|deprecat|no longer issues|stops promising'

# Everything this machine has decided and not yet published. Committed work is the point: a decision
# is committed per topic long before the session ends, so a working-tree diff would be empty exactly
# when this matters. Falls back to the working tree alone when there is no upstream to compare to.
base=""
if git -C "$REPO_ROOT" rev-parse --verify --quiet '@{upstream}' >/dev/null 2>&1; then
  base="$(git -C "$REPO_ROOT" rev-parse '@{upstream}' 2>/dev/null)"
fi
# Overridable so the hook can be pointed at a known-bad range and shown to fire — a guard nobody has
# watched work is a guard nobody should trust. `DECISION_DRIFT_BASE=<sha> bash .claude/hooks/decision-drift.sh`
[ -n "${DECISION_DRIFT_BASE:-}" ] && base="$DECISION_DRIFT_BASE"

added_lines_by_file() {
  if [ -n "$base" ]; then
    git -C "$REPO_ROOT" diff "$base"...HEAD -- src 2>/dev/null
    git -C "$REPO_ROOT" diff HEAD -- src 2>/dev/null
  else
    git -C "$REPO_ROOT" diff HEAD -- src 2>/dev/null
  fi
}

# The always-read part only: line 1 up to the line before "## Features built". The two reference
# sections below it are grepped rather than read, and a stale line there is what the integrity test
# already covers.
features_line="$(grep -n '^## Features built' "$INSTRUCTIONS" | head -1 | cut -d: -f1)"
[ -z "$features_line" ] && exit 0
always_read="$(head -n "$((features_line - 1))" "$INSTRUCTIONS")"

# Walk the diff, remembering which file each hunk belongs to, and collect the files whose ADDED
# lines declare a decision.
suspects="$(added_lines_by_file | awk '
  /^\+\+\+ b\// { file = substr($0, 7); next }
  /^\+/ && file != "" { print file "\t" substr($0, 2) }
' | grep -Ei "$DECISION_RE" | cut -f1 | sort -u)"

[ -z "$suspects" ] && exit 0

hits=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  base_name="$(basename "$file")"
  dir_name="$(dirname "$file" | sed 's|^src/||')"
  # Mentioned by file name, or by the directory a rule would name instead (`lib/invoicing/` is how
  # the invoice rule referred to `src/lib/invoicing/buyer-invoice.ts`).
  if printf '%s' "$always_read" | grep -qF "$base_name" \
     || printf '%s' "$always_read" | grep -qF "$dir_name/"; then
    hits="${hits}  · ${file}
"
  fi
done <<< "$suspects"

[ -z "$hits" ] && exit 0

cat >&2 <<EOF
⚠️  A DECISION landed in a module the always-read rules also talk about:

${hits}
AI_INSTRUCTIONS.md's always-read part (line 1 → "## Features built") states a rule about each of
these. A decision is exactly the thing that turns such a rule false while every automated check
stays green — the path still exists, the budget still holds, the tests are still green, and the next
session reads the sentence and believes it.

Open the file's header, read what it now says, then grep the always-read part for the OLD rule and
correct it. Pay for any added characters by moving rationale into the module (the budget is a
ratchet — tests/instructions-budget.test.ts).

This happened on 2026-08-13 with lib/invoicing/buyer-invoice.ts, and a later session wrote a whole
audit row on top of the stale sentence before the owner caught it by asking. Not a blocker.
EOF
exit 0
