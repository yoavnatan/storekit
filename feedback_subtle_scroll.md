---
name: feedback-subtle-scroll
description: "prefer minimal/subtle auto-scroll (block:'nearest') over hard alignment (center/start) for in-app UX"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 31e29c92-e175-4824-aeb4-1c586d0e26c3
---

Default new `scrollIntoView()` auto-scroll interactions to `{ behavior: 'smooth', block: 'nearest' }`, not `'center'` or `'start'`. `'center'`/`'start'` force a full re-alignment even when the target is already mostly visible, which reads as an abrupt, imprecise jump. `'nearest'` only moves the viewport the minimum distance needed.

Exception: when the goal is specifically to guarantee a multi-element region (e.g. a reply textarea + its action buttons) is fully visible together, `block: 'end'` on the wrapping container is the right call — the point is placement, not minimalism.

**Why:** user corrected this twice in the same session (2026-07-06) on the buyer/seller message-thread scroll behavior — first calling `'center'` "not precise" because it hid the reply box, then separately asking that the close-button's scroll-back also be "more refined." Relates to [[feedback_design_philosophy]] (avoid jarring, prefer refined/professional motion).

**How to apply:** when wiring any new auto-scroll-into-view behavior, start from `block: 'nearest'` and only deviate (e.g. to `'end'`) when there's a concrete reason a specific edge must be visible.
