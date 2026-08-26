# Bug classes that are not specific to any project

Each of these actually shipped here and cost real time. They are stack-independent, so a new project
can be born with them instead of buying them again. Check the diff against this list before saying
done — this is the list the review step reads.

## An id is not a permission

Holding an identifier proves you know the identifier, nothing else. A session proves which accounts
a person owns; it never proves they own THIS record. Found here: the no-JavaScript form fallbacks
were open while their API twins were correctly guarded — the same action, two entry points, one
checked.

Rule: every entry point to an action re-derives ownership from the session. Grep for the action, not
for the route.

## Written is not applied

A migration file in the repo is not a migration that ran. A generated asset committed to source is
not the asset in the bucket. Both are invisible to the test suite, which reads the source. Anything
whose effect lives outside the repo needs its own check.

## A stale read under contention

`SELECT` then `UPDATE` is two moments. Do the decision in one statement and let the affected-row
count be the answer — zero rows means reject. But a REFUSAL must re-read, because the statement's
opening snapshot is exactly the number that was wrong.

## No idempotency on an external write

Any call that moves money, sends a message, or creates a record on another system needs a key that
makes a repeat a no-op. Webhooks retry. Users double-click. Networks time out after the work
succeeded. And never auto-retry a charge.

## Each side right, only the join wrong

Two modules that each pass their own tests and disagree about the format between them. Found here as
a product feed where the catalog id was generated one way and consumed another — no error anywhere,
just an empty result. Test the SEAM with one real value carried end to end.

## Silent format rejection

An external system that accepts your submission and drops the rows it dislikes. One bad character
kills a feed with a 200 response. If a third party validates your output, you must read its report,
not its status code.

## Twin drift

Two features built from one template diverge when only one is fixed. Fix one, grep for the other in
the same commit.

## A test that builds the state the bug is not in

The suite is green because the fixture starts after the broken step. Assert on the RANGE of inputs,
and make sure the test constructs the state the user actually arrives in.

## A number displayed without an invariant

Any figure a person will act on needs a property that must always hold, tested — not just a snapshot
of today's output. Snapshots lock in whatever was wrong when they were taken.

## A guard that has never failed

See `accrual.md`. It belongs on this list too, because it is the class that hides all the others.
