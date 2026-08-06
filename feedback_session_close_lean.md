---
name: feedback-session-close-lean
description: "Keep AI_INSTRUCTIONS.md lean at end of every session — ~200 lines is a soft trigger, and it applies to the ALWAYS-READ part only (not the two reference indexes)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b181424b-bfb3-4afe-9bf2-21fee7b99307
  modified: 2026-07-28T14:15:33.674Z
---

At end-of-session updates, keep AI_INSTRUCTIONS.md compact:
- Merge new feature info into existing bullets — never add a duplicate bullet
- One line per feature max, no implementation details (those live in the code)
- One line per file in Project structure
- ~200 lines is a trigger to go compress — not a hard ceiling to force-fit content under
- **The ~200 applies to the ALWAYS-READ part only (settled 2026-07-28, user: "אופטימיזציה חכמה").** That's line 1 → `## Features built`, plus `## Workflow` → end — 147 lines / ~37k chars at the time. **Features built** and **Project structure** are excluded: the file's own header protocol says to grep them, never read them linearly, and explicitly not to delete them to save tokens. Measuring the whole file (453) against 200 pointed the compression at exactly the content that already costs nothing to carry. Re-measure both parts before acting; don't trust a number written in a doc.

**Why:** The instructions file was growing into a token sink. User asked to keep it lean and efficient — "כמה שיותר יעיל, רזה, לעניין." That's the actual goal (qualitative); 200 is just a number picked to operationalize it, never something the user dictated as a hard limit. User corrected this directly (2026-07-10): pushed back when this got applied as a rigid ceiling, worried it forces dropping real context (decisions/gotchas not recoverable from the code) just to hit a round number — confirmed 200 isn't sacred. His own framing of the goal (same conversation): "איזון: שלא ייאבד הקונטקסט המלא, אבל גם שלא נשתה טוקנים בלי הכרה" — balance between not losing full context and not burning tokens carelessly. Neither side wins by default; it's a judgment call each time.

**How to apply:** After every session-close update, do a line count check. If well past 200, look for genuinely redundant/stale/code-derivable content to compress first. If nothing redundant is left to cut and the new content is real, non-recoverable-from-code context (a decision, a gotcha, a "why"), let the file run longer rather than mangling or dropping it — lean is the goal, not the number itself.

**Repeated correction (2026-07-15):** caught writing whole narrative paragraphs per new feature — algorithm internals (seeded-PRNG formulas, CPM band numbers), a step-by-step bug-diagnosis walkthrough, restated code comments. That's implementation detail even though it's "just one bullet" — the line-count rule alone didn't stop it. Concrete test before writing a bullet: would a `grep`+`Read` of the actual file answer this? If yes, cut it — name the file/function and stop. Keep only what a reader can't get from the code: a decision made, a footgun avoided, a thing *not* to redo (like the sticky-header revert). One or two sentences per feature, not a paragraph.

**Division of labour with memory — settled 2026-07-27, this is what stops the same text living in two places.** AI_INSTRUCTIONS "Features built" = what exists in the code + the gotchas around it. A memory file = the owner's decision, the *why*, and what was rejected. When a feature has both, each file carries its own half and **points** at the other ("full detail in memory `X`" / "described in AI_INSTRUCTIONS → Y") instead of restating it. Enforcement pass done 2026-07-27 on order-card-layout, shipping-model, business-model-pricing and store-readiness-gate — check for this drift whenever a session-close touches a feature that already has a memory.
