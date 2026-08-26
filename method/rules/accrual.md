# How the project learns

This is the mechanism that made the month worth something, and the one a new project has least of.
A new project starts with the machinery and an empty failure log. This file is how the log fills.

## A fix is not done until the class is closed

Fixing the bug is half. The other half: find every other place the same mistake could live, fix those
too, and add a guard that fails if it comes back. Otherwise the same bug ships from a different file
next month.

## A guard must be watched to FAIL

A guard test that has only ever been green is not known to be a guard. Three of them here passed for
weeks while guarding nothing. Break the code on purpose, watch the test go red, then fix it.
ENFORCED here by a script that scans for guards which cannot fail.

## A guard scans the tree, never an allowlist

If the guard checks a list of files, a brand-new file is uncovered the moment it exists — and adding
it to the list means you just created a second definition of the rule. Scan the whole source tree.

## A ✅ expires

Marking an area reviewed is a claim that stops being true the moment the code moves. A drift command
names the rows whose code changed since they were signed off. A stale ✅ over moved code is worse
than an honest empty box, because it gets believed.

## Audit the area, not only the diff

Code untouched since it shipped appears in no diff and is never re-read. That is where the expensive
bugs were found here — a broken product feed, authorization holes in the no-JavaScript fallbacks, a
sitemap that silently stopped at its URL ceiling. One area per session, as side-work.

## Memory: one fact per file, and an index that is budgeted

Each thing learned is its own file with a one-line description. An index file lists them, one line
each, and the index has a character ratchet that may only come down. Without the ratchet the index
grows until nobody reads it, which is the same as having no memory.

Two kinds, and only one of them transfers to the next project:
what the OWNER taught me about how to work — those move to any project untouched;
what THIS project taught me about itself — those stay.

## Write the discarded attempt down

An optimization that was tried and measured worse is worth as much as one that worked, because
without the note the next session tries it again. Both failed test-runner remedies here are recorded
beside the code they would have changed.

## The instructions file is not allowed to grow

Adding a rule is paid for by MOVING an equivalent amount of rationale into the file that rule
governs — a module header, a hook, a checklist row — leaving the rule plus a pointer. Relocation,
never deletion: nothing learned may be lost to save bytes, and a gotcha read at the moment it applies
beats one skimmed at session start.

A test checks that every pointer still leads somewhere. What it cannot check is whether the note
still tells the TRUTH — both errors found the day it was written were a correct path with a false
claim beside it. So when you touch a module, confirm the claim in the CODE before rewriting it.
