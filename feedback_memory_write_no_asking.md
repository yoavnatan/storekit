---
name: feedback_memory_write_no_asking
description: "Never ask permission to write to memory — standing approval, just write it and mention it in the summary"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e2466b3a-647d-4549-a82a-fe4cd0f75e12
  modified: 2026-07-29T07:56:08.401Z
---

Never ask whether it's OK to save something to memory. The answer is always yes — this is standing, permanent approval (user, 2026-07-29: "stop asking me at every session close whether writing to memory is approved, always yes").

**Why:** the question has no useful answer variant. It costs a round-trip at the exact moment the session is being closed down, and the user has never once said no.

**How to apply:** write the memory file + its `MEMORY.md` index line directly, then note it in one line of the closing summary ("זיכרון — שתי רשומות חדשות: …"). Same for updating or deleting a memory that turned out wrong. This does NOT extend to `CURRENT_TASK.md`, which stays fully user-owned ([[feedback_current_task]]) — the standing approval is about MY memory store, not his files.
