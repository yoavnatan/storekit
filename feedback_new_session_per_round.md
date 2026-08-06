---
name: feedback-new-session-per-round
description: "proactively tell the user when to open a new chat after finishing a work round/checkpoint, to save tokens"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5acb7a2e-1058-49e8-84c4-d20290ae9630
---

At the end of every completed round/checkpoint (e.g. a dashboard.css CSS-migration round, or any other multi-round task broken into checkpoints), proactively tell the user whether this is a good point to open a new chat — don't wait for them to ask.

**Why:** User wants to manage token usage deliberately; a long session accumulates context (full file reads, exploration) that a fresh session doesn't need once progress is checkpointed in `CURRENT_TASK.md`/`AI_INSTRUCTIONS.md`. See [[feedback_token_efficiency]].

**How to apply:** After marking a round done (checkpoint written to `CURRENT_TASK.md`), add a short line recommending new-chat or continue-here, with brief reasoning (e.g. "checkpoint is clean, a new session picks up from CURRENT_TASK.md with no loss" vs. "next step is tightly coupled to what we just discussed, fine to continue here"). Keep it terse — one or two sentences, not a section. Don't wait for the user to ask "should I open a new chat?".
