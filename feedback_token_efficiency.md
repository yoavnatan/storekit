---
name: feedback-token-efficiency
description: "minimize tokens spent per request without losing context — grep before read, no full-file dumps, no unnecessary exploration"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 31e29c92-e175-4824-aeb4-1c586d0e26c3
---

Every request should stay lean: locate the exact lines first (grep/targeted search), then read only that slice (Read with offset/limit) instead of dumping whole files. Don't re-explore context already established earlier in the session. Don't spawn subagents for work doable directly in a few targeted tool calls. Don't re-read a file just edited to "verify" — the Edit tool already confirms success.

**Why:** user said directly he feels responses "get lost" and burn thousands of tokens per request even for small, well-scoped asks (2026-07-06). This is the general/broader version of [[feedback_testing_strategy]] (browser/tsc scope) and [[feedback_no_overthinking]] (looping/overthinking) — this one is about tool-call and file-read economy specifically.

**How to apply:** before reading a file, prefer `grep -n` to find the relevant line range, then `Read` with `offset`/`limit` around it. Batch independent greps/reads in one parallel call. Keep chat replies to what changed + what's next — no restating already-known plans. Only widen scope (full-file read, Explore agent, multi-file survey) when the targeted approach genuinely fails to locate what's needed.

**Repeated (2026-07-16):** user raised the same complaint again — general sense of over-elaborating during sessions, not just end-of-task ("מרגיש לי שאתה מפרט הרבה יותר מדי בסשנים שלנו... מרוב אינפורמציה אתה מבזבז טוקנים"). This is a standing pattern, not a one-off — treat verbosity as the default failure mode to actively guard against, not just avoid when reminded. Applies to in-session text updates too (see [[feedback_concise_summaries]] for the end-of-task angle): shorter status lines, no restating context, no over-explaining reasoning the user didn't ask for.
