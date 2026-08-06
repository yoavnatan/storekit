---
name: feedback-line-limit-guideline
description: "The 200-line-per-file rule applies to every source file (not just AI_INSTRUCTIONS.md) but is a guideline/smell-detector, not a hard ceiling — skip a split that would hurt flow more than help"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5393a504-8226-4d7e-97fb-0236dcc25f57
---

The "No file > 200 lines" hard rule in AI_INSTRUCTIONS.md applies to **every source file** in the project, not just AI_INSTRUCTIONS.md itself (user initially assumed it was scoped to that one file — it isn't). But the user explicitly downgraded its enforcement: treat it as a **guideline/flag to stop and check**, not an absolute hard rule to force-satisfy.

**Why:** In the 2026-07-12 session, splitting `store-products.ts` (CRUD vs. CSV-bulk logic) and `product.ts` (API handling vs. form-parsing helpers) both produced clean, natural SRP wins — the split concerns were genuinely independent. But `gallery.ts` (431 lines) has functions that all share closure-scoped state (`activeSlot`, `wState`, `panel`, etc.) within one `initGalleryWidget()` call — splitting it "just to hit 200" would require awkwardly threading that state across files or introducing a class/controller, a real architectural change with regression risk, not a free cleanup. I explained this nuance to the user (some splits are natural, some aren't) and they agreed and generalized it as standing guidance.

**How to apply:** When a file crosses ~200 lines, pause and ask: does splitting it separate genuinely independent concerns (do it), or would it just relocate the same tightly-coupled state across file boundaries (leave it, note the size as an accepted tradeoff)? Don't rush a split at the end of a long/bug-fixing session just to satisfy the number — see [[feedback_architecture]] for the broader (still non-negotiable) modularity principles this doesn't override: layer separation, SRP, no globals. This guideline only softens the specific line-count metric, not those.
