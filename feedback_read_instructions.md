---
name: feedback_read_instructions
description: Always read AI_INSTRUCTIONS.md at the start of every session
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a66d5493-34e4-47e6-a7e9-d7ec0dfd9c71
  modified: 2026-07-26T10:53:09.591Z
---

At the start of every session, read `AI_INSTRUCTIONS.md` + `CURRENT_TASK.md` before doing anything else — even if the user hasn't explicitly asked. **But read it token-smart (protocol added 2026-07-26 to stop burning tokens):** read linearly ONLY through the end of **Hard rules**, plus the **Workflow** section at the very end. The **Features built** and **Project structure** sections in between are a REFERENCE INDEX — never read them top-to-bottom; `grep` them for the one feature/file the current task touches. The file self-documents this in its opening note.

**Why:** The user expects full project context (architecture, hard rules, workflow) every session, but the file is large (~376 lines) and reading it whole every time was wasting tokens — his explicit complaint (CURRENT_TASK item 0, 2026-07-26). The rules govern behavior and must be read; Features/Project-structure are lookup material only needed when touching that area.

**How to apply:** First action in a new session = read AI_INSTRUCTIONS.md rules-through-Hard-rules + Workflow + CURRENT_TASK.md; grep the two reference sections on demand. Do NOT split the file into two (rejected — see [[feedback_ai_instructions_no_split]]); the protocol gives the same saving without splitting.

**Mechanically (tightened 2026-07-27 — "read smart" alone wasn't enough, sessions still Read the file whole):** never call `Read` on AI_INSTRUCTIONS.md without offset/limit. Run `grep -n "^## " AI_INSTRUCTIONS.md` first to get the current section boundaries (they shift — never reuse remembered line numbers), then Read line 1 → the line before `## Features built`, and `## Workflow` → end. Measured 2026-07-27: that's ~34K chars vs ~139K for the whole file, a ~4x cut in session-start cost. The file's own opening note carries these same steps.
