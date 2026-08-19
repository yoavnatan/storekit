#!/usr/bin/env bash
# Tells the session that just WROTE a memory that the index is over its ratchet.
#
# ── Why a hook and not a test (owner, 2026-08-20) ──
# `MEMORY.md` is one file, symlinked, shared by every session on this machine and living outside
# every worktree. As a test in `npm run verify` its ratchet reddened the suite of every session at
# once — including sessions that had never touched memory, could not see the file in their tree, and
# whose only honest response was to stop their own work and trim a shared file while another session
# was editing the same lines. That happened three times in one evening.
#
# The budget itself has not moved. What moved is WHO is told: the session that added the line, at
# the moment it added it, which is the only one that can pay for it. `tests/memory-index.test.ts`
# still fails hard at the number that actually breaks a session (the harness silently refuses to
# load an oversized index), so ignoring this for a week is still caught by the suite.
#
# Advisory by design: it prints and exits 0. A memory write is usually the last thing a session does
# and it is worth more than the byte it costs — blocking it would trade a fact the next session needs
# for a formatting chore.
set -euo pipefail

CEILING=18000

payload="$(cat 2>/dev/null || true)"
path="$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

# Only when the write actually landed in the memory directory — every other file is none of this
# hook's business, and it must cost nothing on the writes that are not.
case "$path" in
  *"/memory/"*) ;;
  *) exit 0 ;;
esac

index="${path%/memory/*}/memory/MEMORY.md"
[ -f "$index" ] || exit 0

bytes="$(wc -c < "$index" | tr -d ' ')"
[ "$bytes" -le "$CEILING" ] && exit 0

cat <<EOF
⚠️  MEMORY.md is ${bytes} bytes — $((bytes - CEILING)) over the ${CEILING} ratchet.

Pay for what you just added, in this session, before the next one inherits it: merge two same-topic
index lines, or move a hook's detail down into the memory file it points at. Do NOT delete a memory
and do not raise the ceiling — the file is the only thing a fresh session knows about this project,
and past ~24,400 bytes the harness stops loading it entirely, silently.
EOF
exit 0
