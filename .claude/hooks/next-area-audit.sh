#!/bin/bash
# SessionStart — name the area whose audit is oldest, so the session does not get to choose.
#
# The hole this closes (owner, 2026-08-10, asking why the area audit does not run on a schedule).
# Workflow §3.5 says one row per session, as side-work. That has held for a week — 7 of 11 rows
# marked between 2026-08-06 and 08-10 — but look at WHICH rows: every one of them is the area that
# session happened to be working in. Row 11 was marked the day the failure-notice work was done,
# row 9 the day the load work was done, row 7 the day the draft-recovery bug was reported.
#
# That is the easy half and it is nearly free, because the area is already in context. It is also
# the half that finds the least: an area you just spent a day inside is the one you least need to
# re-read. The rows that stayed ☐ are the ones nobody had a reason to open — inventory+checkout,
# domains, SEO-as-one-surface — and "nobody had a reason to open it" is exactly the condition the
# feed bugs lived under for months.
#
# So the choice moves out of the session. This prints the oldest ☐/partial row at start, before any
# work has created a bias about which area is interesting. It does not block and it does not nag: a
# session with a real task does that task, and this is a standing answer to "which one, then?" that
# costs nothing to ignore for a day and is impossible to drift past for a month.
#
# It reads the table in the review-diff skill rather than keeping its own list, because a second
# list of areas is a second thing to update and would be wrong within the week.
set -uo pipefail

cat >/dev/null 2>&1 || true   # drain the hook's stdin JSON

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TABLE="$DIR/../skills/review-diff/SKILL.md"
REPO="$DIR/../.."
[ -r "$TABLE" ] || exit 0

# A row is "open" when its Audited cell has no ✅. `partial` counts as open — row 3 has read half
# of inventory+checkout and stopping there is how a partial becomes a permanent.
open_rows="$(grep -E '^\| [0-9]+ \|' "$TABLE" | grep -v '✅' || true)"
[ -n "$open_rows" ] || exit 0

count="$(printf '%s\n' "$open_rows" | wc -l | tr -d ' ')"
# The lowest-numbered open row: the table is ordered by how much the project depends on the area,
# so "oldest unaudited" and "most load-bearing unaudited" are the same pick.
next="$(printf '%s\n' "$open_rows" | head -1 | awk -F '|' '{print $2 " —" $3}' | sed 's/  */ /g')"

# Counted, not written down. It said "of the 11 areas" while the table held 12, and then 17 — a
# hardcoded total in a file whose whole job is to report the state of a list that grows.
total="$(grep -cE '^\| [0-9]+ \|' "$TABLE")"

cat <<EOF
Area audit — $count of the $total areas are still open, and the next one in order is:

 ▸$next

This is the side-work half of Workflow §3.5, and it is named here because the session is otherwise
the one choosing — which has meant, every time so far, auditing whatever area the session was
already working in. That is the half that finds the least. Reading an area NOBODY has had a reason
to open, end to end against a rule from outside this codebase, is the half that found the feed
bugs, the no-JS authorization holes and the 50,000-URL sitemap ceiling.

Not a blocker and not today's task: do the user's work first. Take it when the session has room,
and if you do, mark the row in the same session or say plainly that you did not.
EOF

# ── And the rows that WERE audited, whose code has moved since ────────────────────────────────
#
# A ✅ is a statement about the code that existed on that date, and the table has always said so in
# prose while nothing acted on it. Row 7 audited the dashboard's forms on 2026-08-09; the panel
# loading model under them was replaced on 08-11; the row still read ✅ while five bugs came out of
# exactly that change, every one found by the owner (2026-08-16, asking whether the audits should
# re-run periodically — they should not; they should re-open when their subject moves).
#
# One command, no pipes: an earlier version piped the JSON into `node -e` and the hook hung waiting
# on stdin, which at session start is a start that never happens. Every failure path here exits
# quietly for the same reason — a notice that can break the start is worse than an absent one.
top="$(cd "$REPO" 2>/dev/null && node scripts/audit-drift.mjs --top 2>/dev/null)" || exit 0
[ -n "$top" ] || exit 0

cat <<EOF

Already audited, but the code under them has MOVED since — ranked by how much:

$top

\`npm run audit:drift\` for the full list. Re-reading a drifted row is far cheaper than a fresh
audit: only what changed since that date has to be read again.
EOF
