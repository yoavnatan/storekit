# method/

Copy this folder into any project and Claude will work the way you want it to, without you having
to say so again.

    node method/install.mjs /path/to/your-project

You do not need to know what is inside. Two things change, and you will notice both.

**Claude answers the way you asked.** Not "tries to". Every reply is measured before it reaches you,
and one that is too long or too full of jargon is thrown away and rewritten. The rules it is measured
against are in `rules/communication.md` — that file is yours. Open it, change any line, and the next
reply obeys the new version.

**Claude cannot tell you something works when it doesn't.** Before it is allowed to finish a reply,
it runs the project. If anything is broken, it is sent back to fix it and you never see the "all
done" that wasn't true.

Everything else here is Claude reading its own notes.

---

## Starting something new

Make an empty folder, open Claude in it, and say what you want to build. Claude asks four questions —
what it is, what it should be written in, where it will run, and what has to work for you to call it
finished — and then builds it. Any language.

If you do not know the answer to the language question, say so and it will pick one and tell you why.

## When something feels wrong

If the answers get long and technical again, open `rules/communication.md` and look at the numbers in
it. They are plain and you can change them.

If Claude says something is finished and it is not, that is a real failure and worth saying out loud
— the whole point of this folder is that it cannot happen quietly.

---

## For Claude, not for the owner

`kickoff.md` — what to do in an empty folder.
`rules/communication.md` — the reply rules. Enforced by `enforce/style-check.mjs`.
`rules/optimization.md` — every speed mechanism the original project built, with the measurement that
bought it and the two attempts that were tried and measured worse.
`rules/parallel.md` — one session per working tree, and why two in one deadlock.
`rules/accrual.md` — how a project keeps what it learns instead of relearning it.
`rules/bug-classes.md` — the failures that repeat in every project. Check a diff against it.
`enforce/verify.mjs` — the one command that runs the project's checks, declared in `checks.json`.
`enforce/require-green.mjs` — refuses to end a turn while those are failing.
`enforce/one-way-to-verify.mjs` — refuses a check run any other way.
`user-contract.md` — installed to `~/.claude/CLAUDE.md`, loaded in every folder.

The numbers in `rules/` were measured on one machine and one stack. Carry the shape and re-measure;
a copied number nobody re-took is a claim, not a measurement.
