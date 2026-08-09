#!/bin/bash
# Stop — the same worktree scan, at the other end of the session.
#
# Why a second hook and not just the SessionStart one (owner, 2026-08-04, and he is right):
# being told at the START is being told after the fact. By then the work has already been left, and
# the only session that knew WHY it was left is gone. "A session must not be able to end without
# knowing what it is leaving behind" is a rule about the END of a session, so it has to run there.
#
# It does NOT block, and that is deliberate. Blocking on unmerged commits would deadlock the very
# case it is meant for: a worktree session's work is unmerged for its entire life, so the gate would
# fire on every turn and the turn could never end. Merging is also never this hook's call —
# AI_INSTRUCTIONS §4 is explicit that it is the owner's. So it speaks, once, at the moment the
# decision is actually in front of somebody.
#
# CLOSING A WORKTREE OUT IS THE SESSION'S CALL, NOT A QUESTION FOR THE OWNER (owner, 2026-08-05 —
# moved here from AI_INSTRUCTIONS §4 on 2026-08-09, because this hook is what puts the decision in
# front of you). When the task is done and `npm run verify -- --all` is green: merge main IN, then
# fast-forward main, confirm `git log main..<branch>` is empty, and remove the tree. Never push from
# a worktree (memory `project_prepush_hook_wiped_worktree`), and never leave one LIVE or ORPHANED.
#
# Two different things get said, and conflating them is what made the start-of-session report easy
# to skim past:
#   • THIS tree — you are the session that is leaving. Say what is unmerged and what it would take.
#   • ANOTHER tree with nobody in it — an orphan that survived a whole session without being noticed.
#
# Silent when there is nothing outstanding anywhere, and silent about a 🔵 tree with a live session:
# that is somebody working, not something forgotten.
set -uo pipefail

cat >/dev/null 2>&1 || true   # drain the hook's stdin JSON

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$DIR/review-state.sh"    # REPO_ROOT
source "$DIR/worktree-scan.sh"   # scan_worktrees

# The tree this session is working in. `review-state.sh` resolves REPO_ROOT with `rev-parse
# --show-toplevel` FROM THE HOOKS DIRECTORY, and inside a linked worktree that is the worktree's own
# root — which is exactly what "this tree" has to mean here, and the same thing the review gate
# fingerprints. Not `$PWD`: a hook's cwd is not guaranteed.
here="$REPO_ROOT"

# ── Heartbeat: register this session against the tree it is ACTUALLY in ──────────────────────────
#
# Found while testing this hook, and it is the flaw that would have made the whole report untrust-
# worthy: `one-session-per-tree.sh` registers a session at SessionStart, in whatever tree it started
# in — but a session that then calls `EnterWorktree` (which is what the project instructions tell it
# to do) never registers anywhere else. So its worktree reads as "unmerged work and nobody in it"
# while somebody is actively typing in it, and the next session is told to raise a ⚠️ about live
# work. A warning that cries wolf is worse than no warning.
#
# Stop runs at the end of every turn, so it is the natural heartbeat: stamp this tree, and drop this
# PID from any other tree's list, because a session is in exactly one tree at a time. Only ever this
# session's own PID is touched. The timestamp is LAST SEEN rather than started, which is what makes
# the 12h staleness cutoff in `session_live_in` mean "gone" instead of "been here a while".
session_dir_for() {
  printf '/tmp/claude-review-state-%s/sessions' "$(printf '%s' "$1" | shasum | cut -d' ' -f1)"
}
my_dir="$(session_dir_for "$here")"
# Line 1 is last-seen, line 2 is this session's transcript path — the two things `session_live_in`
# reads (review-state.sh). Line 2 is CARRIED, not dropped: SessionStart is what knows the transcript
# path, so overwriting the file with a bare timestamp would leave a session that is mid-command —
# no Stop for twenty minutes — looking idle to the next session, which is the deadlock this pair of
# hooks exists to prevent.
mkdir -p "$my_dir" 2>/dev/null || true
prev_transcript="$(sed -n 2p "$my_dir/$PPID" 2>/dev/null || echo '')"
printf '%s\n%s\n' "$(date +%s)" "$prev_transcript" > "$my_dir/$PPID" 2>/dev/null || true
while IFS= read -r other; do
  [ -n "$other" ] && [ "$other" != "$here" ] && rm -f "$(session_dir_for "$other")/$PPID" 2>/dev/null
done <<EOF
$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
EOF

# Has real work been COMMITTED in this worktree, as opposed to it having just been created?
#
# The distinction the "clean and merged" line below cannot do without. A brand-new worktree and a
# finished one look identical to `main..HEAD` — both say zero — so without this the hook would open
# every worktree session by suggesting you delete the worktree you just made. The branch's own
# reflog separates them: a commit made HERE leaves a `commit:` entry, and creation alone does not.
did_work_in() {
  [ "$(git -C "$1" reflog show HEAD 2>/dev/null | grep -c 'commit')" -gt 0 ]
}

mine=""
finished=""
orphans=""
while IFS=$'\t' read -r status wt branch detail; do
  [ -n "${status:-}" ] || continue
  case "$status" in
    clean)
      # Nothing outstanding — and THAT is the moment the worktree should stop existing. This hook
      # used to go silent here, which is precisely the hole the owner walked into on 2026-08-04: the
      # work was merged and pushed, the report had nothing to say, and the leftover directory was
      # noticed by him rather than by the mechanism. Silence is right for "nothing happened here";
      # it is wrong for "this is done".
      did_work_in "$wt" || continue
      if [ "$wt" = "$here" ] || ! session_live_in "$wt"; then
        finished+="  ✅ ${wt}  [${branch}]\n"
      fi
      ;;
    orphan)
      if [ "$wt" = "$here" ]; then
        mine="[${branch}] ${detail}"
      else
        orphans+="  ⚠️ ${wt}  [${branch}] ${detail}\n"
      fi
      ;;
    live)
      # A live session in ANOTHER tree is fine. A live session in THIS tree is this session, and its
      # own unmerged work is exactly what the handoff line is for.
      [ "$wt" = "$here" ] && mine="[${branch}] ${detail}"
      ;;
  esac
done <<EOF
$(scan_worktrees "$REPO_ROOT")
EOF

[ -n "$mine" ] || [ -n "$orphans" ] || [ -n "$finished" ] || exit 0

echo "worktree handoff — say this to the user in Hebrew, at the END of your reply, in one line each:"
echo
if [ -n "$mine" ]; then
  printf 'YOUR OWN TREE still holds work that main cannot see: %s\n' "$mine"
  cat <<'EOF'
  → If the work is FINISHED and the full verify is green, close it out yourself, without asking —
    standing instruction from the owner, 2026-08-05 ("אתה תחליט"), because the judgement of when it
    is done is mine to make: `git merge main` into the branch, `verify -- --all`, fast-forward main,
    confirm `git log main..<branch>` is empty, then `ExitWorktree remove`. Do NOT push; local is the
    approval, publishing is not.
  → If you are MID-TASK, leave it and say so in one line — mid-task work is supposed to be unmerged.
    Either way the session must not end with the user unaware the branch exists.
EOF
fi
if [ -n "$finished" ]; then
  echo
  echo "DONE AND STILL ON DISK — merged into main, nothing uncommitted, work was committed there:"
  printf '%b' "$finished"
  cat <<'EOF'
  → Remove it as part of finishing, without being asked: `ExitWorktree remove` for your own tree,
    `git worktree remove <path>` for one nobody is in. This is the ONE worktree state where the
    action is unambiguous and nothing can be lost — the commits are on main. Leaving it is how the
    list fills up with directories nobody trusts, until a real ⚠️ reads like more of the same.
EOF
fi
if [ -n "$orphans" ]; then
  echo
  echo "ANOTHER worktree has unmerged work and nobody in it:"
  printf '%b' "$orphans"
  cat <<'EOF'
  → Tell him it exists and what is on it (`git log --oneline main..<branch>` says it in one line).
    The decision to merge or delete is his; the point of this line is that it is never made by
    default, by nobody, because everyone assumed somebody else knew.
EOF
fi
