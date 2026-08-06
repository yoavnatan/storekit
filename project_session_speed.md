---
name: project_session_speed
description: Session-time optimization — npm run verify replaces the serial check loop and (2026-08-03) skips a check whose inputs are byte-identical to its last pass; always-read doc budget is a char ratchet
metadata: 
  node_type: memory
  type: project
  originSessionId: e793b8a0-544e-4b52-960d-b7c7598c7ea4
  modified: 2026-08-04T07:58:35.903Z
---

Two measured causes of "every session takes forever", both fixed 2026-07-31:

1. **The verification loop.** Running `tsc` → `astro check` → `lint` → `npm test` by hand is ~115s
   per checkpoint (measured: 9 / 39 / 37 / 30). **`npm run verify`** (`scripts/verify.mjs`) picks the
   checks the working diff needs, runs them concurrently off content-hashed caches, and prints only
   failures — ~30s when no `.astro` changed, ~45s when one did. `npm run verify -- --all` forces
   everything; the Stop hook (`require-green.sh`) calls that and no longer duplicates the run logic.
   Nothing is weakened: skipped checks are named in the output, `--all` uses cache-free `astro check`,
   and CI still runs all four plus a build on a clean checkout.

2. **The always-read doc slice grew 4x unnoticed** — 12.3k → 52.2k chars between 2026-07-08 and
   07-30, while its *line* count (the budget's unit) grew only 38%, because the lines are paragraphs
   (111 → 341 chars average). The budget is now **characters, ratcheted**, enforced by
   `tests/instructions-budget.test.ts`; the ceiling may only come down (now 40,800; the slice is
   **40.5k**, down 22% in the same session). Paying for a new rule means **relocating** rationale to
   the file it governs — never deleting it. Where things went, as the worked example: main.css split
   rule → `main.css`; radius + tactile-depth scales → `base/tokens.css`; button feedback recipes →
   `components/buttons.css`; header layout → `Header.astro`; CSS on-contact exceptions + legacy-file
   inventory → `remind-css-conversion.sh`; prefetch limit → `astro.config.mjs`; sticky scroll layers
   → `scroll-utils.ts`; no-free-trial reasoning → `lib/pricing.ts`; lint-baseline history →
   `eslint.config.js`; payment-provider comparison → `GO_LIVE_CHECKLIST` §3.
   Fixed on the way: AI_INSTRUCTIONS claimed commission lives at
   `store.config.ts → checkout.commissionPercent`, which contradicted both the code and its own
   pricing paragraph — commission is per-seller-tier in `lib/pricing.ts`.

3. **"Is AI_INSTRUCTIONS still optimal?" is now a test, not an end-of-session chore.**
   `tests/instructions-integrity.test.ts` (<0.5s, inside `npm test`) fails if a pointer in the
   always-read rules resolves to nothing, if a `path ← note` in Project structure isn't on disk, or
   if a tracked `src/` file is undocumented — the manual audit the workflow used to ask for. Paired
   with the budget ratchet, the end-of-session check costs zero extra time. **Its blind spot,
   stated in the file:** it cannot tell whether a note is TRUE. Both errors found on 2026-07-31 were
   a correct path with a false claim next to it, and only reading the code caught those.

The user's constraint on all of this (stated mid-session): optimize without losing context and
without weakening the bug-catching. So: move text, never drop it; keep every check, only stop
waiting on it serially. See [[feedback_testing_strategy]], [[feedback_token_efficiency]].

**2026-08-03 — measured again, from the transcripts of the previous 30 sessions, and this is the
number to reason from:** 489 min of Bash wall-time across those sessions, of which **verification was
87%** (verify 278 min over 341 calls · standalone `vitest` 80 min over 446 · standalone
`astro check`/`tsc` 66 min over 173). The dominant single check is **`astro check` at 64–84s** and it
has no cache of its own; the suite is ~2,080 tests in ~40–50s; lint ~9–14s warm. Two fixes shipped:

- **verify now skips a check whose inputs are byte-identical to the last time that check passed** —
  one `path → content-hash` map of the tree (`.claude/` and `.md` excluded, so the session-close doc
  pass no longer re-runs anything — **except AI_INSTRUCTIONS.md, which two tests read**: excluding it
  produced a genuine false green on 2026-08-04, `verify --all` reporting cached-green after a docs
  edit that could have turned `instructions-integrity`/`-budget` red. `CHECKED_DOCS` in verify.mjs
  now carves it back in, and `tests/verify-doc-inputs.test.ts` fails if any test starts reading a
  `.md` that is still excluded. Editing that one doc therefore costs a full suite run — correct, and
  the reason to keep the carve-out narrow.) Cold 64+13+40s → **0.2s** on a repeat. It must stay
  content-keyed and say nothing about staging: the first version keyed off `ls-files -s` text and so
  **every `git commit` threw the cache away**, which is exactly when the pre-push gate runs.
  `--no-cache` forces. This is not the tools' own caches — those make a rerun cheaper, this makes it
  not happen.
- **The rule that produced the other half:** `npm run verify` is the ONLY way to run these checks —
  never `astro check` / `tsc` / a whole `vitest run` by hand (one test file while iterating is fine).
  Those 619 hand-run calls duplicated what verify had just run and what the Stop hook was about to.

Also measured, and worth not re-deriving: session wall-time is **not** dominated by commands
(~16 min of a ~80 min session). It is dominated by generation — ~249k output tokens per session.
Tool output is a small share of context (~130k chars/session distinct, mostly Bash+grep+Read).
So after this, further speed comes from **narrower scope per session**, not from faster checks.

Still not addressed, and the honest remaining driver: each session does far more than its stated item
(fix-everything-you-find, defence layers, tests, doc updates, review gate) — that is deliberate
policy, not waste.
