# method/

The working method, as a folder. Portable to any project, any stack.

Install it somewhere else:

    node method/install.mjs /path/to/new-project

That copies this folder, wires the style gate into that project's `.claude/settings.json` without
touching hooks it already has, and writes `~/.claude/CLAUDE.md` if it is missing — the file Claude
loads automatically in every folder on this machine, with no command to remember.

## The one idea this folder is built on

A rule that is written down is a preference. A rule that is enforced by a hook is a rule.

The evidence is this project. The owner asked for shorter, plainer answers hundreds of times over a
month. It was written into memory and into the instructions file, both read at the start of every
session, and it never held. Over the same month not one session ended on failing code — because a
Stop hook blocks that, and there is nothing to remember.

So every rule here either names its enforcer or is explicitly labelled unenforced. Nothing is
allowed to sit in between, pretending.

## What is here

`rules/communication.md` — how replies are written. Yoav's file, in Hebrew, meant to be edited.
Enforced by `enforce/style-check.mjs`.

`rules/optimization.md` — every speed mechanism this project built, with the measurement that
justified it and the attempts that were tried and measured worse.

`rules/parallel.md` — one session per tree, why it deadlocks otherwise, how a worktree is opened and
closed.

`rules/accrual.md` — how a project learns: closing a bug CLASS, guards proved to fail, a ✅ that
expires, memory that is budgeted.

`rules/bug-classes.md` — the failures that are not specific to any project. Check a diff against this
before saying done.

`user-contract.md` — the always-loaded version, installed to `~/.claude/CLAUDE.md`.

`enforce/style-check.mjs` — the Stop hook. Reads the last reply, measures it against
`rules/communication.md`, blocks the turn with the specific violations. Bounded at three blocks, then
it warns and lets the turn end; a gate with no escape hatch gets switched off.

## What is NOT here, on purpose

This project's other hooks and its `verify` script. They are coupled to this stack, and a checker
written for one stack does not merely fail in another — it looks correct while checking nothing.
They are carried as rules in `rules/optimization.md` for the next project to implement in its own
terms, and re-measured there.

The numbers throughout are from this machine and this stack. Carry the shape, re-take the number. A
copied measurement nobody re-took is the same failure as a ✅ over code that has moved.

## Trying a rule out

    node method/enforce/style-check.mjs --text "some reply"
    node method/enforce/style-check.mjs --file draft.md

Exit 1 and a list of violations, or `style: ok`.

## What this cannot do

It carries the machinery, not the knowledge. A new project starts with working gates and an empty
failure log. `rules/accrual.md` is how that log fills — it is the most important file here and the
slowest to pay off.
