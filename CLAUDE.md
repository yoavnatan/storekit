# CLAUDE.md

<!-- EDIT PERMISSION: standing approval. Edit when the work requires it — never stop the session to ask. -->

**The instructions are in `AI_INSTRUCTIONS.md`.** Read it and `CURRENT_TASK.md` before doing
anything — and read it the way its own first line says to, with `grep`/offset rather than whole,
because the middle of it is a reference index and not session-start reading.

Nothing else belongs in this file, and that is a rule rather than a preference. `AI_INSTRUCTIONS.md`
is one file on purpose (memory `feedback_ai_instructions_no_split`) and its always-read part is
ratcheted against a character budget that `tests/instructions-budget.test.ts` enforces. Splitting
guidance across two always-read files would quietly reopen both. This file exists for exactly one
thing the other cannot do: **be read when nothing else has been.**

That is not hypothetical. Everything that normally points a session at `AI_INSTRUCTIONS.md` —
memory `feedback_read_instructions` above all — lives in the private memory repo, which is restored
by a script that a session only knows to run because `AI_INSTRUCTIONS.md` told it to. On an
existing machine the circle is already closed and none of this matters. On a fresh clone it is a
circle with no entry, and the whole point of a root `CLAUDE.md` is that the harness loads it
without being told.

---

## Restoring on a new machine

**Trigger:** the owner says he is restoring, or setting up on a new/other machine — or `.claude-memory/`
is absent, which means the same thing whether he said it or not.

He should not have to know any command for this. Do the work, then tell him only what is left.

1. **`bash scripts/setup-claude-memory.sh`** — clones the private `storekit-memory` repo into
   `.claude-memory/`, symlinks the harness memory path at it, and enables `.githooks` so a future
   `git push` of the code backs memory up again. Everything you know about this project arrives in
   this step.
2. **`npm ci`** — a checkout has no `node_modules`, and without it every check resolves binaries
   that do not exist and reports red on the tooling rather than on the code.
3. **Now read `AI_INSTRUCTIONS.md` and `CURRENT_TASK.md`** — memory exists as of step 1, so from
   here this is an ordinary session start.
4. **Check `.env`.** It is in no repo, deliberately and by the owner's decision (2026-08-09): every
   value in it can be reissued from a console, so a backup would have bought minutes of convenience
   for a second place the secrets can leak from. Do not propose backing it up again. Five values
   have to come from him — `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `PUBLIC_CLOUDINARY_CLOUD_NAME`, `PUBLIC_CLOUDINARY_UPLOAD_PRESET` — and `.env.example` names the
   console each one comes from. Everything else in that file works empty.
5. **Report in Hebrew, short.** What is already working, then the list of what only he can supply,
   with where to get each. `⚠️ דורש אותך` on top, per memory `feedback_language`.

**Never**, in this flow or any other: invent or guess an `.env` value, commit `.env`, or push.
Pushing is his call every time (memory `feedback_worktree_merge_authority`), and here it is also the
thing that would send a half-restored state to the remote.

`tests/handoff-backup.test.ts` pins that the five variables named above still exist in
`.env.example`, so a rename cannot leave this page quietly wrong. A restore note that has drifted is
worse than none: it gets read once, under pressure, and believed.
