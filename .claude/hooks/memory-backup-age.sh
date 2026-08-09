#!/bin/bash
# Stop — say something when memory has gone too long without reaching GitHub.
#
# The hole this closes (owner, 2026-08-09, while asking what survives if this machine dies).
# Memory is backed up by `.githooks/pre-push`, which runs on a push of the CODE. That is a good
# arrangement and it costs nothing — but it means the backup is a side effect of an action that has
# its own unrelated schedule. A stretch of memory-only work is a stretch of unbacked memory, and
# NOTHING anywhere said so. Every other risk in this project announces itself; this one was silent
# by construction, which is the worst shape a data-loss risk can have.
#
# Why it is not a command he runs. That was the first design and he threw it out, correctly: a check
# you have to remember to run protects you exactly as well as your memory of it, and he had already
# said the same thing about the restore flow — he wants to be told, not to hold a procedure. So it
# lives where the decision is actually in front of somebody, which is the end of a session.
#
# ── The part that decides whether this is useful or wallpaper ──
#
# It does NOT fire on "memory is dirty". Memory is dirty most of the time — writing it is a normal
# part of a session, and a line that appears every turn is one nobody reads by the third day.
# `worktree-handoff.sh` says the same thing about crying wolf and it is right. What matters is not
# that there is unbacked memory; it is that the LAST BACKUP is old. So: silent unless there is
# something unbacked AND the last one reached GitHub more than a day ago.
#
# Measured against origin, not the local memory branch. A local commit that never left the machine
# is not a backup — it is the same disk, in a different directory.
set -uo pipefail

cat >/dev/null 2>&1 || true   # drain the hook's stdin JSON

STALE_AFTER=86400   # 24h. Below this the next ordinary push carries it and there is nothing to say.

# `.claude-memory` lives in the MAIN checkout, and a worktree session must look there rather than at
# its own root — `worktree-setup.mjs` symlinks the harness memory path at that one directory on
# purpose, so there is exactly one memory repo per machine no matter how many trees exist.
COMMON="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
MEM="$(dirname "$COMMON")/.claude-memory"

# No memory repo at all is a different situation with a different answer (CLAUDE.md → the restore
# protocol), and a session in it has louder problems than a backup age. Not this hook's business.
[ -d "$MEM/.git" ] || exit 0

# The ref that stands for "what GitHub actually has". Three spellings tried in order rather than one
# assumed: `@{upstream}` is right whenever the branch tracks anything, `origin/HEAD` exists after a
# clone but NOT after a `git init` + `remote add`, and `origin/main` is the last resort for a
# checkout where neither was ever set. Empty means nothing of this repo is known to be on a remote,
# which is not a reason to stay quiet — it is the loudest case there is.
remote=""
for ref in '@{upstream}' 'origin/HEAD' 'origin/main'; do
  if git -C "$MEM" rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then remote="$ref"; break; fi
done

dirty="$(git -C "$MEM" status --porcelain 2>/dev/null | grep -c . || true)"
ahead=0
[ -n "$remote" ] && ahead="$(git -C "$MEM" log --oneline "$remote..HEAD" 2>/dev/null | grep -c . || true)"
[ "${dirty:-0}" -gt 0 ] || [ "${ahead:-0}" -gt 0 ] || exit 0

# When the newest thing on the REMOTE was written. Absent → age 0 → treated as overdue, which is
# what "never backed up at all" deserves.
last=0
[ -n "$remote" ] && last="$(git -C "$MEM" log -1 --format=%ct "$remote" 2>/dev/null || echo 0)"
now="$(date +%s)"
age=$(( now - ${last:-0} ))
[ "$age" -gt "$STALE_AFTER" ] || exit 0

days=$(( age / 86400 ))
if [ "${last:-0}" -eq 0 ]; then
  when="never — nothing of it has ever reached GitHub"
elif [ "$days" -ge 1 ]; then
  when="${days} day(s) ago"
else
  when="$(( age / 3600 )) hours ago"
fi

what=""
[ "${dirty:-0}" -gt 0 ] && what="${dirty} file(s) written but not committed"
if [ "${ahead:-0}" -gt 0 ]; then
  [ -n "$what" ] && what+=", "
  what+="${ahead} commit(s) never pushed"
fi

cat <<EOF
memory backup is overdue — say this to the user in Hebrew, ONE line, at the END of your reply:

  ⚠️ Memory last reached GitHub ${when}. Unbacked right now: ${what}.

  → The fix is a push of the CODE repo: \`.githooks/pre-push\` commits and pushes memory as part of
    it. There is no separate memory command and there should not be one.
  → Pushing is HIS call, every time (memory \`feedback_worktree_merge_authority\`). Say the number,
    offer the push, and do not run it unasked — this hook exists to make the state visible, not to
    turn it into a reason to publish on his behalf.
  → If he says no, that is an answer. Do not repeat it later in the same session.
EOF
