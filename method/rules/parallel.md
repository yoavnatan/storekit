# Parallel sessions

The rule: one session per working tree, always. Every session after the first moves to its own git
worktree before its first edit.

Why it is not optional. Two sessions in one checkout do not collide on files — they collide on the
gates. Every gate keys off a fingerprint of the whole tree, so the other session's keystroke voids
your check cache, resets the block counter, and fails you on code you do not own. The turn then never
ends. Measured here: five sessions in one tree on 2026-08-09, and the day was lost to it.

ENFORCED at three points, because being told once was not enough:
a SessionStart hook tells the later session to move out;
a PreToolUse hook BLOCKS its first edit if it did not;
a Stop hook reports what the session leaves behind, because being told at the START is being told
after the fact — by then the work has already been left.

## Setting one up

Enter the worktree, then run the project's worktree setup command FIRST. A bare checkout has no
dependencies and no environment file, so every check resolves binaries that do not exist and reports
red on the tooling rather than on the code. The setup step also warms the caches, because a first run
in a new tree is cold.

## Closing one out — my call, not a question

Green → rebase onto the main branch → fast-forward → remove → push.

Rebase, not merge. The merge form was writing a commit per closeout that carried no work: 221 of 923
commits in one fortnight were merges, 145 of them the catch-up kind. Rebase gives the same guarantee
— the branch is verified sitting on top of current main — and main then fast-forwards with no merge
commit at all. Rewriting is safe because a worktree branch is never pushed.

The full check runs ONCE, before the push. Not again because main moved.

## What a worktree cannot isolate

A migration NUMBER. Two sessions each creating "migration 0031" is a conflict no branch can prevent.
Anything with a shared global counter has to be split by task, not by tree.

## What must never be touched

A tree with a live session in it. Its work is unfinished by definition.

An orphaned tree with unmerged commits. The author who knew why is gone, and only the owner can say
whether it should live. Ask with its contents inside the question, or leave it alone. Never absorb it
into main, and never merely announce that it exists — a status line the owner cannot act on costs
the same attention as a real question and carries none of the value.

## Splitting the work

Say the split out loud before starting, and make sure more than two sessions actually have
independent work. Two sessions editing the same module in different trees is a merge conflict with
extra steps.
