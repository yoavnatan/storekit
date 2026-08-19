#!/bin/bash
# SessionStart — report every linked worktree that still holds work, so a parallel session can
# never quietly become a fork of the project.
#
# Why this exists. one-session-per-tree.sh routes the 2nd, 3rd, Nth session OUT of the shared tree
# and into a worktree of its own, which is what makes working on several things at once safe. But
# it creates the opposite risk, and the owner named it before it ever happened (2026-08-04): a
# worktree whose branch never gets merged is work that is *in the repo* and *invisible on main* —
# you close the laptop believing a feature shipped, and it is sitting on a branch nobody will look
# at again. AI_INSTRUCTIONS Workflow §4 already says "merge then remove as soon as it's done", and
# a rule you have to remember at exactly the moment you are tired is not a safeguard.
#
# So: every session, in EVERY tree (main or linked), opens with the true state of all of them. You
# do not have to be in the right directory, or remember a worktree exists, to be told about it.
#
# **This is only half of it.** Being told at the start is being told after the fact — the session
# that left the work is the one that knew why, and it is already gone. `worktree-handoff.sh` runs
# the same scan at Stop, so nobody leaves without being asked about it (owner, 2026-08-04). The scan
# itself lives in worktree-scan.sh; both hooks are readings of it.
#
# Quiet when there is nothing to say — no worktrees, or all of them clean and merged. A hook that
# speaks on every session gets skimmed past, and then it is not a safeguard either. The one thing
# it does say about a tidy worktree is that it is safe to delete, because that is how they stop
# accumulating until nobody trusts the list.
set -uo pipefail

cat >/dev/null 2>&1 || true   # drain the hook's stdin JSON

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$DIR/review-state.sh"    # REPO_ROOT
source "$DIR/worktree-scan.sh"   # scan_worktrees

report=""
count=0
while IFS=$'\t' read -r status wt branch detail; do
  [ -n "${status:-}" ] || continue
  count=$((count + 1))
  case "$status" in
    gone)   report+="  • ${wt}  — הספרייה נמחקה; \`git worktree prune\` ינקה את הרישום\n" ;;
    clean)  report+="  ✅ ${wt}\n     [${branch}] נקי וממוזג — אפשר להסיר: ExitWorktree remove\n" ;;
    # Outstanding work with somebody still in the room is the NORMAL state of parallel work, not a
    # problem. Marked, so the list stays complete, but never as something to act on.
    live)   report+="  🔵 ${wt}\n     [${branch}] ${detail} — סשן פעיל, בעבודה. אין מה למזג עכשיו.\n" ;;
    orphan) report+="  ⚠️ ${wt}\n     [${branch}] ${detail} — אין סשן פעיל.\n" ;;
  esac
done <<EOF
$(scan_worktrees "$REPO_ROOT")
EOF

[ "$count" -gt 0 ] || exit 0
[ -n "$report" ] || exit 0

printf 'קיימים %d worktree מלבד העץ הראשי:\n\n' "$count"
printf '%b\n' "$report"
cat <<'EOF'
A ⚠️ line is addressed to YOU, not to him. Do NOT open your reply with it, and do not "report" it at
all. He ruled on that (2026-08-18): *"זה טוב שאתה יודע את זה ושם לב, אבל מה איכפת לי?"* and, the same
day, *"נסה לדבר איתי בצורה שרלוונטית לי... או דברים שאני לא מבין או דברים שאתה יכול פשוט לטפל בהם"*.
A status line he cannot act on costs him the same attention as a real question and carries none of
the value.

The hook's purpose is unchanged — work that exists in the repo and is invisible on main must not be
lost — but the next step is YOURS. Go and look: `git -C <wt> log --oneline main..HEAD` and
`git -C <wt> status --short`, then:

  • Nothing there, or commits already in main → not an orphan. Remove it, say nothing.
  • Real work you can judge → judge it, handle it, one line at most in the summary.
  • Real work whose fate is genuinely HIS taste (design he'll live with, a product direction) → an
    **AskUserQuestion card** (memory `feedback_ask_via_ui_question`) naming what the work IS: how
    many files, which area, committed or not. "There is an orphan worktree" is not a question.

A 🔵 line is NOT that. It is a session working right now, and mid-task work is supposed to be
unmerged — mention it only if he asks what is running. Never offer to merge one.

YOUR OWN worktree — the one this session created — is yours to close out, without asking. The owner
made that explicit on 2026-08-05 ("אתה תחליט"), because he does not know when it is the right moment
and I do: when the work is done and the full verify is green, **`git rebase main`** — not
`git merge main` — then re-run `verify -- --all`, fast-forward main, then remove it. Rebase, because
the merge form was writing a commit per closeout that carries no work: 221 of the 923 commits in the
fortnight to 2026-08-18 were merges, 145 of them the "Merge branch 'main' into worktree-X" catch-up
kind, so a one-topic change landed as two or three lines of history instead of one. He asked about
exactly that (2026-08-18: "אתה עושה יותר מדי קומיטים"). Rebase gives the same guarantee the merge was
there for — the branch is verified sitting on top of current main — and main then fast-forwards with
no merge commit at all. Rewriting the branch is safe here precisely because a worktree branch is
never pushed. Confirm `git log main..<branch>` is
EMPTY before removing — `ExitWorktree remove` counts commits against the branch POINT, not against
main, so it will warn about discarding dozens that are all already merged.

A ✅ line belonging to some other session is safe to remove too: clean and merged is nothing to lose.

Two things stay off-limits, and they are why this is not "merge whatever you find". Never touch a 🔵
tree — a session is working in it and a merge lands on top of unfinished work. Never merge a ⚠️
orphan: its commits are somebody's abandoned mid-task work, the author who knew why is gone, and
only he can say whether it should live. Ask about it — with its contents inside the question — or
leave it alone; never absorb it into main, and never merely announce it.

Pushing main is standing too, once verify is green (2026-08-16). It was written here as "never push"
on the reasoning that his 08-05 approval covered merging only; he asked whether he had ever actually
said that, and he had not. `pre-push` runs verify and refuses a red tree, which is the real gate.
What stays off-limits is pushing a BRANCH — an orphan or someone's live work is not yours to publish.

The state can change while you work — another session may merge and remove a worktree mid-turn. Re-run
`git worktree list` before telling the user a worktree still needs a decision.
EOF
