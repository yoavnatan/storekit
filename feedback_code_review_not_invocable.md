---
name: feedback-code-review-not-invocable
description: /code-review and /security-review are user-triggered only — I cannot launch them; review the diff manually and say so
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2b1d3bee-5dee-40de-9221-ab6c830a2914
  modified: 2026-07-30T12:39:55.739Z
---

`/code-review` (and `ultra`) cannot be invoked by me — the harness refuses model invocation of the
skill outright. Same for `/security-review`. They are the user's to run.

**Why:** `AI_INSTRUCTIONS.md` carried a "Security review gate" rule for weeks that said to *run*
`/code-review` on any diff touching money/auth/inventory/cart/checkout. That instruction was never
executable, so the gate it described silently amounted to no review at all. Corrected in the file
2026-07-29.

**How to apply:** when the gate triggers, do the review myself — read the diff hunk by hunk against
the known classes ([[project_attribute_escaping_xss]], [[project_json_script_xss]],
[[project_redos_regex_class]], [[project_safe_redirect]], price re-validation, status-value sweeps
per [[feedback_new_state_sweep_consumers]]) — then report what was checked. Never say or imply
`/code-review` ran. This is a concrete instance of [[feedback_dont_imply_unverified_diligence]]: the
gate read as diligence while doing nothing.

**Separate the two things, or it reads as ducking the job (user pushed back 2026-07-30: "we agreed
this would be at your initiative").** *Reviewing* is mine and proactive — the `review-diff` skill plus
the Stop-hook gate exist precisely because the slash command isn't model-invocable, and reviewing is
never something to wait to be asked for. Only that one *slash command* is the user's to trigger.
So lead with what I reviewed and found; mention `/code-review` at most as an optional independent
second pass, and don't close a review with "it's yours to run" — that sentence is what made it sound
like no review had happened.
