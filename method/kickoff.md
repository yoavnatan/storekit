# Starting a project from nothing

Instructions to Claude, not to the owner. He should never have to know a command for this.

**Trigger:** the folder is empty or nearly empty, or he says he is starting something new. If
`CURRENT_TASK.md` already exists, this is not a kickoff — read it and work.

The point of this file: he opens a folder, says what he wants, and gets a project that already has
the gates. Any language, any framework. The stack is his choice or a recommendation he accepts; the
method does not change with it.

---

## 1. Ask, once

One `AskUserQuestion` card, at most four questions, then stop asking. A long interview is a barrier
(`rules/communication.md`, and the same rule that says never burden a user with a form he cannot
answer).

**Assume the person cannot answer a technical question, and phrase every option so they do not have
to.** Not "Postgres or SQLite" — "should the data survive if the computer restarts?". Not "SSR or
static" — "will other people visit this on the internet?". If an answer genuinely requires knowing
something they will not know, do not ask it: decide, and say in one line what you decided and why.
A question somebody cannot answer is not consultation, it is an obstacle.

What you need:

**What is it** — free text is fine, one line. What the thing does and who uses it.

**What it should be built with** — three concrete options, recommendation first, each described by
what it means for HIM rather than by its name: how common it is, whether he could hire help for it,
what it is normally used for. If he does not care, pick and say you picked.

**Where it runs** — his machine only, a server, a phone, someone else's browser. Ask it in exactly
those words. This decides more than the language does.

**What has to work for him to call it finished** — in his words. You translate that into the first
check in `checks.json`; never ask him to phrase it as a test.

Anything else he wants you to know, he will say. Do not ask a fifth question.

## 2. Write down the decisions before writing code

`AI_INSTRUCTIONS.md`, from his answers. What is being built, the constraints, what has been decided
and is not to be re-litigated. This section is the whole reason the same argument does not happen
three times — in the project this came from, re-opened decisions cost more than any bug.

`CURRENT_TASK.md` is his file. Create it with a `Your instruction` heading and nothing under it, and
never write to that section again. It is how he steers.

## 3. Build the skeleton with the framework's own tool

Never hand-roll a project layout. Use the real thing — the framework's create command, the language's
package initialiser — and let it produce whatever it produces. Hand-written scaffolding is wrong in
ways that only surface later, and it is not yours to maintain.

Then `git init` and a first commit, before anything else. A gate that cannot see a diff is not a gate.

## 4. Declare the checks, and prove each one can FAIL

Write `method/checks.json`: for each check a `name`, the `command` that runs it, and the `inputs`
globs that decide whether it can be skipped when nothing changed.

Then break something on purpose and watch each check go red. A check that has only ever been green
is not known to be a check — three guards in the original project passed for weeks while guarding
nothing. This step is not optional and it takes two minutes.

At minimum: a build or type check, and one real test. A project whose only check is a linter has no
gate.

## 5. Wire the gates

    node method/install.mjs .

Run it AGAIN here even if it was run before the project existed. On an empty folder there is nothing
on disk to detect a stack from, so the first pass leaves `method/checks.json` empty on purpose; this
pass fills it in from the skeleton that now exists. Skipping it leaves the project with an empty gate
that prints green forever — the worst of the three states, because it looks like the other two.

Style gate, green gate, and the one-way-to-verify block are merged into `.claude/settings.json`
without disturbing anything already there. Then run `node method/enforce/verify.mjs --all` and see
green.

## 6. Tell him what he has

Short. What runs, what the first check is, and the one thing he has to supply if there is one. Not a
tour of the folder.

---

## While the project runs

Read `rules/` when the situation calls for it, not all at once:
`communication.md` before every reply — it is enforced anyway;
`parallel.md` when a second session opens;
`optimization.md` when a check starts feeling slow;
`bug-classes.md` before saying a change is done;
`accrual.md` at the end of a session, when something learned needs to survive.

The rules folder starts full and the project's own knowledge starts empty. Filling the second one is
the actual work, and `accrual.md` is how.
