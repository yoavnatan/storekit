#!/bin/bash
# SessionStart — name the two areas most worth auditing, so the session does not get to choose.
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
# So the choice moves out of the session. This prints TWO candidates at start, before any work has
# created a bias about which area is interesting: the oldest ☐/partial row, and the audited row
# whose code has moved most since. Both are picked here, which is the whole guarantee — what a
# session gets to decide is only how much room it has, which is a fact about the session rather
# than an opinion about the areas. It does not block and it does not nag: a session with a real
# task does that task, and this is a standing answer to "which one, then?" that costs nothing to
# ignore for a day and is impossible to drift past for a month.
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
next="$(printf '%s\n' "$open_rows" | head -1 | awk -F '|' '{print "row" $2 "—" $3}' | sed 's/  */ /g; s/ *$//')"

# Counted, not written down. It said "of the 11 areas" while the table held 12, and then 17 — a
# hardcoded total in a file whose whole job is to report the state of a list that grows.
total="$(grep -cE '^\| [0-9]+ \|' "$TABLE")"

# ── The rows that WERE audited, whose code has moved since ────────────────────────────────────
#
# A ✅ is a statement about the code that existed on that date, and the table has always said so in
# prose while nothing acted on it. Row 7 audited the dashboard's forms on 2026-08-09; the panel
# loading model under them was replaced on 08-11; the row still read ✅ while five bugs came out of
# exactly that change, every one found by the owner (2026-08-16, asking whether the audits should
# re-run periodically — they should not; they should re-open when their subject moves).
#
# THIS USED TO PRINT UNDERNEATH AS TRIVIA, and that is why nothing ever came of it (owner,
# 2026-08-23: "למה לא לבחור בכל סשן ביקורת שנכון לעשות לפי המצב הקיים"). One row was named as the
# instruction and three were listed as background, so a session with an hour and no appetite for a
# whole area took neither. It is now the SECOND CANDIDATE, printed the same size as the first, with
# what it costs attached — because the two differ by roughly a day, and that difference is the
# whole reason a session picks one and skips the other.
#
# What did NOT change, and is the point of the hook: both candidates are chosen HERE. The rule from
# 2026-08-10 was never "a fixed order is better than judgement", it was "the session must not be
# the one choosing", because when it was, it picked the area it had just spent the day inside every
# single time. Offering two externally-chosen options costs nothing against that.
#
# One command, no pipes: an earlier version piped the JSON into `node -e` and the hook hung waiting
# on stdin, which at session start is a start that never happens. Every failure path here exits
# quietly for the same reason — a notice that can break the start is worse than an absent one.
top="$(cd "$REPO" 2>/dev/null && node scripts/audit-drift.mjs --top 2>/dev/null)" || top=""
drift_row="$(printf '%s\n' "$top" | sed -n '1p' | sed 's/^ *//')"
drift_cost="$(printf '%s\n' "$top" | sed -n '2p' | sed 's/^ *//')"

cat <<EOF
Area audit — $count of the $total areas are still open. Two candidates, and BOTH are picked here
rather than by you. Take one when the session has room:

 ▸ A FIRST READ — $next
   Never read end to end against a contract from outside this codebase. The expensive one and the
   valuable one: the whole area, plus a guard test that scans the tree.
EOF

if [ -n "$drift_row" ]; then
cat <<EOF

 ▸ A RE-READ — $drift_row
   $drift_cost. Only those files have to be read again — hours, not a day.
EOF
fi

cat <<EOF

Which one is a question about how much room this session has, not about which area interests you.
With a day, take the first read: an area NOBODY has had a reason to open is where the feed bugs,
the no-JS authorization holes and the 50,000-URL sitemap ceiling were found, and that is the half
a session left to itself never picks. With an hour, take the re-read rather than neither — a ✅
sitting over code that has moved is a claim that has quietly stopped being true, which is worse
than an honest ☐.

Not a blocker and not today's task: do the user's work first. If you take one, mark the row in the
same session or say plainly that you did not. \`npm run audit:drift\` for every drifted row.
EOF
