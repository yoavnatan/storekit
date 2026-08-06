---
name: feedback-session-close
description: "When the user says \"סגור את הסשן\", run the full end-of-session workflow — and audit the session's own diff first"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3e88778b-62ce-48f1-865a-a5e449729863
  modified: 2026-07-29T17:33:28.958Z
---

"סגור את הסשן הנוכחי" (or "we're done" / "next session") = run the end-of-session workflow in `AI_INSTRUCTIONS.md` § **Workflow step 5** — that file is the authority, follow it as written rather than a copy here.

Before the doc work, audit the session's OWN diff (user asked explicitly, 2026-07-29): no acrobatics to reach something simple, no dead code. Concretely — grep every symbol you added for real call sites (an export only the tests use is dead: assert it through the public behaviour instead and delete it), drop leftover blank lines and comments describing code that changed, and confirm each new abstraction earns its place.

Two things that are NOT part of the close, despite what an older version of this note said: there is no "Build status" or "Session log" section anymore, and `CURRENT_TASK.md`'s `Your instruction` / `Next` are user-owned — never write to them (see [[feedback_current_task]]).

**Why:** the user wants a clean handoff — the next session starts from `AI_INSTRUCTIONS.md` alone, so a stale line there sends it to the wrong place, and code nobody calls reads as intentional to whoever finds it next.
