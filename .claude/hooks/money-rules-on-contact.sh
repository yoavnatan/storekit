#!/bin/bash
# PostToolUse (Edit|Write) — the money rules, delivered at the moment somebody edits money code.
#
# Same idea as remind-css-conversion.sh, applied to the surface where being wrong costs a real
# person's money. Measured 2026-08-09 over the sessions of 2026-08-04→09: **8 of 40 sessions that
# edited anything touched a money surface**, so four sessions in five were carrying the full rules
# through their entire context for a file they never opened — while the session that DID open one got
# them once, at session start, before it knew which file it would be.
#
# So the always-read bullet in AI_INSTRUCTIONS keeps the rule and every module name (a pointer is
# what makes a rule findable, and `tests/instructions-integrity.test.ts` checks that they resolve),
# and the reasoning — the traps, what each helper is FOR, what a new number owes — lives here and
# arrives on contact. Nothing was deleted; on contact you now get more than the always-read bullet
# ever said, and off it you still get the rule.
#
# POST, and not for lack of trying PRE. Firing before the edit would be strictly better here — "use
# lib/money.ts" is worth more before the arithmetic is typed than after — so it was built that way
# first, and it silently did nothing: `PreToolUse`'s hookSpecificOutput carries `permissionDecision`,
# `permissionDecisionReason` and `updatedInput`, and NOT `additionalContext` (code.claude.com/docs/en/
# hooks, checked 2026-08-09; the events that do carry it are SessionStart, UserPromptSubmit,
# PostToolUse and Stop). The hook ran, printed valid JSON, and the field was dropped — which is the
# worst failure shape a briefing can have, so it is written down here rather than rediscovered. Post
# is the same event remind-css-conversion.sh has used all along, and the rules still land before the
# tests, the guard scans and the review gate. It never blocks: a briefing is not a gate.
#
# THE PATTERN IS DELIBERATELY GENEROUS. A hook that misses is worse than one that fires needlessly:
# the cost of a false positive is ~500 tokens in a session already editing adjacent code, and the
# cost of a miss is money code written without the rules. So it matches the whole vocabulary
# (money/price/order/pay/refund/balance/discount/checkout/stock/revenue/billing/invoice/commission)
# anywhere under src/, plus every API route, rather than a list of today's filenames — a module that
# does not exist yet is the case this has to cover, exactly as the money guard tests scan the tree
# instead of a file list.
#
# Once per session: the rules are ~2.5k characters and a money session edits several files. The
# marker is keyed by the session id the hook is handed, under the same per-tree state directory the
# other hooks use, so it dies with the tree's state and never leaks between worktrees.
set -uo pipefail

json=$(cat 2>/dev/null || true)

f=$(printf '%s' "$json" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
sid=$(printf '%s' "$json" | jq -r '.session_id // ""' 2>/dev/null || echo "")

[ -n "$f" ] || exit 0

# Lower-cased before matching: `case` is case-sensitive, and half this surface is components —
# PriceTag.astro, OrderCard.astro — which would otherwise slip past a pattern written in lower case.
f_lc="$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')"

case "$f_lc" in
  */src/pages/api/*) ;;
  */src/*money*|*/src/*price*|*/src/*order*|*/src/*pay*|*/src/*refund*|*/src/*balance*) ;;
  */src/*discount*|*/src/*checkout*|*/src/*stock*|*/src/*revenue*|*/src/*billing*) ;;
  */src/*invoice*|*/src/*commission*|*/src/*reconcile*|*/src/*coupon*) ;;
  *) exit 0 ;;
esac

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$DIR/review-state.sh"   # STATE_DIR, already keyed per working tree

marker="$STATE_DIR/money-briefed-${sid:-$PPID}"
[ -f "$marker" ] && exit 0
mkdir -p "$STATE_DIR" 2>/dev/null && : > "$marker" 2>/dev/null || true

read -r -d '' RULE <<'TXT'
Money surface — AI_INSTRUCTIONS.md's rules for it, in full, because this edit is on it. Four things
own the rules and nothing may re-implement them; the guard tests SCAN THE WHOLE TREE, so a brand-new
module is covered the moment it exists, and adding a file to an allowlist means you have just created
a second definition of the rule (which is the bug).

 • lib/money.ts — every amount summed, stored, returned or charged. Hand-rolled rounding is the
   classic defect here: two surfaces round differently and both look right in isolation.
 • lib/business-day.ts — which day or month an event falls on. CONFUSING ITS TWO FAMILIES IS THE BUG,
   and "just use local time" is not the fix: a calendar day from toISOString is UTC, and a report
   that says "today" to a seller in Israel is not the same question as the one a ledger asks.
 • lib/order-status-rules.ts — a new status FILLS A ROW in the table. It never becomes a new `if` at
   a call site; that is how two screens end up disagreeing about what "cancelled" means.
 • lib/orders.ts#countsAsRevenue — `paymentStatus === 'paid'` alone still matches a CANCELLED order.
   Never write that comparison by hand.
 • lib/refund-owed.ts — a CAPTURED payment that stops counting is money owed back to a real person.
   The obligation is written the moment it exists (`refund_due`); `reconcile.ts` reports every open
   one, and `refund_settled` is deliberately written by nothing until a provider can actually refund.

Every money-moving endpoint needs BOTH: an idempotency key (lib/checkout-idempotency.ts) and a
journal entry (lib/money-events.ts) — the journal is the independent record, so a reconciliation can
compare two sources instead of asking the order tables twice.

A new seller- or admin-visible NUMBER needs an invariant in tests/reporting-invariants.test.ts —
parts sum to the whole, two surfaces agree, nothing exceeds its ceiling — plus a case in
tests/reporting-fuzz.test.ts if weird input can reach it. That is what found the negative-revenue bug
nobody had imagined.

Standing policy, not extra scope: any change that moves money or decrements stock ships with a
Vitest test in the SAME change. Stock is one statement — UPDATE ... SET stock = stock - qty WHERE id
= ? AND stock >= qty — and the affected-row count IS the answer (0 = reject); a REFUSAL must then
re-read the count, because the statement's opening snapshot is stale under contention and that
number is what the buyer's page clamps to (store-products.ts#stockAfterRefusal).

ONE DEFENCE IS DELIBERATELY NOT BUILT YET, and this is where its trigger has to arrive, because the
checklist that records it is read before a LAUNCH and this item fires after one. Money is a plain
`number` here, so agorot and shekels add together and TypeScript says nothing. Branded types would
make that a compile error — the only layer in the standing money-defence list still missing. It was
deferred on 2026-08-09 for one reason: unlike every other layer it is not additive, it rewrites the
signature of every function that carries a price. TRIGGER: payments live, the payment webhook
running, and a month of real orders with no emergency fix in the money layer. Order: lib/money.ts
first, then the modules above, then outward. Full entry: GO_LIVE_CHECKLIST.md §3. If you are reading
this and that trigger has passed, it is the next thing to do — do not start it before.

This surface is also the security-review gate's: the Stop hook will not let the turn end until a
review is recorded for this diff. Run the review-diff skill, fix what it finds, then
`bash .claude/hooks/record-review.sh`.
TXT

jq -n --arg ctx "$RULE" \
  '{hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:$ctx}}'
