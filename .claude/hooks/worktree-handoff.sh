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
mkdir -p "$my_dir" 2>/dev/null && date +%s > "$my_dir/$PPID" 2>/dev/null || true
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
    is done is mine to make: rebase onto main, `verify -- --all`, then **`ExitWorktree` with
    action "keep"** — you are worktree-isolated and a guard refuses every git command aimed at the
    shared checkout, so the merge CANNOT be done from in here — then `git merge --ff-only <branch>`
    in the main checkout, confirm `git log main..<branch>` is empty, then `git worktree remove`.
    Do NOT push; local is the approval, publishing is not.
  → ⚠️ THE EXIT STEP IS THE ONE THAT KEEPS GETTING MISSED — three times now (2026-08-05, 08-10,
    08-23), and the third time the owner had to say "אתה בטוח יכול למזג" twice. Two things produce
    the mistake and both are misreadings: the guard's refusal ("a worktree-isolated session's git
    operations must target its own worktree") describes where YOUR git runs, not whether merging is
    allowed; and a live session in the main tree is not a reason either — a fast-forward adds
    commits without touching anyone's uncommitted files, and `--ff-only` refuses rather than
    clobbers. If main moved while you worked: EnterWorktree by path, rebase, exit keep, merge.
  → THE FULL VERIFY RUNS ONCE, BEFORE THE PUSH — not again because main moved (owner, 2026-08-21).
    A rebase onto a newer main changes the tree, so verify's content cache misses and the honest
    instinct is to run the whole thing again; and again when the next session merges; and again on
    the retry after that. That loop was the single biggest waste of session ד׳, and it buys nothing:
    the `pre-push` hook runs `--all` itself, on the commits you are actually pushing, so a real
    conflict between your work and somebody else's is caught there whether you pre-ran it or not.
    One green before the push. Then push and let the gate be the gate.
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
  → Read it first (`git log --oneline main..<branch>`, `git status --short`). Empty, or already on
    main → remove it and say nothing. Otherwise the keep-or-delete call is his, but it goes out as
    an **AskUserQuestion card** naming what the work actually is — never as a line reporting that a
    worktree exists. He ruled 2026-08-18 that a status he cannot act on is noise
    (`feedback_ask_via_ui_question`). The point is only that the decision is never made by default,
    by nobody, because everyone assumed somebody else knew.
EOF
fi
