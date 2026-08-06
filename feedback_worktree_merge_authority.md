---
name: feedback_worktree_merge_authority
description: "Standing approval (2026-08-05) — finishing my own worktree is my call: merge to main + remove without asking; never push, never touch a live or orphaned one"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bbab661f-8f8c-43e8-be67-9a4aeee14a87
  modified: 2026-08-05T13:53:02.814Z
---

**Closing out my own worktree is my decision, not a question.** When the work is done and the full
verify is green: `git merge main` into the branch → `verify -- --all` → fast-forward main → remove the
worktree. No asking, no "⚠️ דורש אותך" line about it.

**Why:** 2026-08-05 I finished a feature in a worktree, committed, and ended the turn telling him to
merge it. He asked "למה לא מיזגת בעצמך?", then "אז למה אתה לא מסיר?", and then made it standing:
*"כן תוסיף כהוראה קבועה כי אני גם ככה לא יודע מתי זה נכון ומתי לא — אתה תחליט."* Handing the decision
back is handing him a judgement call he has no way to make — he cannot see whether verify is green or
whether the branch is fully merged. I can.

**How to apply:**
- Before removing, confirm `git log main..<branch>` is EMPTY. `ExitWorktree remove` counts commits
  against the branch POINT, not against main, so it warns about discarding dozens that are all already
  on main; that warning is not a reason to stop, and an empty range is the proof.
- **Never push.** Local merging is what he approved; publishing the branch is a separate decision.
- **Never** touch a LIVE worktree (a session is in it) or an ORPHAN (unmerged commits, nobody in it) —
  an orphan's commits are somebody's abandoned mid-task work and only he can say whether they live.
  Report an orphan in one line; that part did not change.
- A clean+merged worktree belonging to another session is safe to remove too.

Encoded in the repo as well, so the hooks stop saying the opposite:
`.claude/hooks/worktrees-outstanding.sh`, `.claude/hooks/worktree-handoff.sh`, AI_INSTRUCTIONS
Workflow §4. See [[feedback_parallel_sessions]] for when to open one in the first place, and
[[feedback_commit_granularity]] for what goes in it.
