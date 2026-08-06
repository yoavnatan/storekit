---
name: feedback_no_ambient_looping_motion
description: Decorative layers must not loop forever; pin them to the viewport instead so scrolling itself is the only motion
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d9dd40a2-9509-4661-84d5-438512505578
  modified: 2026-08-01T17:53:41.839Z
---

Endless ambient animation on decoration is rejected. The homepage hero's
dot-pattern used to `scale()` in and out on a 16s infinite loop; the user
asked for it static and pinned to the screen, so scrolling slides the
content past a grid that never moves on its own.

**Why:** perpetual motion in the corner of the eye reads as restless, not
alive. The scroll is already the motion — a decorative layer that also
moves competes with it.

**How to apply:** for a decorative background layer, reach for
`bg-fixed` (`background-attachment: fixed`) before an `@keyframes` loop.
If a loop really is right, it should be finite (an arrival, a state
change), not `infinite`. Same family as [[feedback_clean_design_line]]
and [[feedback_noop_interactions_invisible]].
