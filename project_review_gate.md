---
name: project-review-gate
description: automatic review gate — Stop hook blocks ending a turn until the review-diff skill has reviewed a money/auth/inventory diff
metadata: 
  node_type: memory
  type: project
  originSessionId: 2b1d3bee-5dee-40de-9221-ab6c830a2914
  modified: 2026-07-30T08:13:21.114Z
---

Code review on the sensitive surface is enforced by the harness, not by memory:

- `.claude/skills/review-diff/SKILL.md` — the checklist. Not generic advice: it is the list of bug
  classes that have actually shipped in this repo (see [[project_attribute_escaping_xss]],
  [[project_json_script_xss]], [[project_redos_regex_class]], [[project_safe_redirect]],
  [[project_checkout_idempotency_ownership]], [[feedback_new_state_sweep_consumers]]).
- `.claude/hooks/require-review.sh` — `Stop` hook. Returns `{"decision":"block","reason":…}` when the
  working diff touches money/auth/inventory/checkout and no review is recorded, which forces the
  review before the turn can end.
- `.claude/hooks/record-review.sh` — run at the END of a review. Marker is keyed to a content
  fingerprint (tracked diff + `git hash-object` of every untracked file), so editing more code
  re-arms the gate.
- `.claude/hooks/review-state.sh` — shared fingerprint + sensitive-path detection. Both scripts must
  compute it identically or a recorded review never matches the one being demanded.

**Why:** the user asked for a code-review mechanism and said explicitly "it has to happen
automatically in the flow because I don't know how to do this" — so a reminder is not acceptable, and
`/code-review` is user-triggered only ([[feedback_code_review_not_invocable]]). A blocking Stop hook is
the only shape that runs without him doing anything.

A second `Stop` hook, `.claude/hooks/require-green.sh`, enforces verification the same way: the turn
does not end while `astro check`, `npm run lint` or `npm test` is red. Those three were documented as
"run after every code step", which made them a reminder that enforced nothing. Runs the three
CONCURRENTLY (~60s wall vs ~106s serial), skips entirely when no `.ts/.astro/.mjs` changed, and caches
success against the same fingerprint so an unchanged turn exits instantly.

**How to apply:** both gates are bounded on purpose — max 2 blocks per fingerprint, then the turn ends
with a `systemMessage` warning. Never raise that bound: an inescapable gate gets disabled outright,
which is worse than one that occasionally passes loudly. Never satisfy either gate by running
`record-review.sh` or by suppressing a failure instead of fixing it.

Three gotchas learned building it (2026-07-30): **hooks reload mid-session but skills do NOT** — the
`Stop` hook fired the same session it was written while `review-diff` still returned "Unknown skill",
so follow the SKILL.md checklist by hand until the next session. `REPO_ROOT` must be the git
**toplevel** (`rev-parse --show-toplevel`), not the hooks' parent dir, or `ls-files --others` silently
scopes untracked detection to one folder and the gate looks like it works. And when pipe-testing hook
JSON, never echo captured output through zsh's `echo` — it expands `\n` and makes valid JSON look
malformed.
