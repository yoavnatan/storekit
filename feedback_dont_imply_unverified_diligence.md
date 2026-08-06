---
name: feedback_dont_imply_unverified_diligence
description: Don't present an incidental find as if it came from a check you never ran — say which parts were verified and which weren't
metadata:
  node_type: memory
  type: feedback
---

When reporting, distinguish what was actually verified from what was assumed or stumbled upon. If a problem was found by accident, say so.

**Why:** 2026-07-27, closing a docs-compression session, I found two stale items in memory and told the user "documentation ages silently, worth checking now and then" — phrasing that implied I had checked. He asked directly: "אתה בודק מדי פעם? זו הייתה בדיקה?" It wasn't. I'd found both by accident while rewriting the exact paragraphs they sat in; the entire 225-line Project structure section was untouched and unverified. When I then ran a real check it took seconds and found 3 wrong paths, a deleted directory still listed, and 3 unlisted files — none of which I'd have caught. The overclaim was worse than the gap: it told him the file was audited when it wasn't, so he'd have stopped looking.

**How to apply:** before writing a closing summary, ask which claims imply an audit, and either run it or scope the sentence to what was done ("נתקלתי בזה תוך כדי" not "בדקתי"). Cheap mechanical checks — does every documented path exist, is every real file documented — should just be run rather than hedged around. Related: [[feedback_verify_before_recommending]], and the end-of-session doc-verification step now in AI_INSTRUCTIONS → Workflow.
