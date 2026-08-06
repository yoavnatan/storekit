---
name: feedback_ai_instructions_no_split
description: Considered splitting AI_INSTRUCTIONS.md into rules + a separate on-demand map; decided against — keep it one file
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e2bacf90-7446-4767-93d1-ea7010d988c6
---

Considered (2026-07-19) splitting AI_INSTRUCTIONS.md into a lean always-read rules file + a separate `PROJECT_MAP.md` (Features built + Project structure) loaded only when needed, to cut per-session tokens. **Decided AGAINST — keep it one file.**

**Why:** (1) the Project-structure/Features map earns its place — recovering the same info from code via grep/read costs as much or more, and repeatedly; the map is pre-computed context that prevents re-exploration. (2) On-demand loading introduces miss-risk: I'd have to judge each session whether I "know" an area, and could misjudge, skip the map, then make a mistake or waste tokens exploring. Always-loaded = zero miss-risk. The split trades a certain small cost for an uncertain larger one.

**How to apply:** don't re-propose the split. Manage the file's growth via session-end compression + wording polish (merge bullets, drop truly-stale detail), not structural separation. Related: [[feedback_token_efficiency]], [[feedback_session_close_lean]].
