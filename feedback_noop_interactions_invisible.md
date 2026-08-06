---
name: feedback_noop_interactions_invisible
description: "An interaction that changes nothing must produce zero visible effect — no re-render, no 2px shift"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ac370cad-f245-42d2-8858-b493ab525348
  modified: 2026-07-28T12:50:46.102Z
---

If a click (or opening/closing a menu) doesn't change any state, it must not move or repaint anything — not even by 2px. The user notices sub-pixel-scale movement and reads it as a bug.

**Why:** raised twice on 2026-07-28 about table filter dropdowns — first "נקה סינון" doing a full re-render when nothing was selected, then a ~2px table shift just from opening and closing a dropdown. His words: "אם שום דבר לא היה לחוץ, למה בכלל לעשות משהו?" / "זה לא אמור להשפיע בכלל על המיקום של הטבלה".

**How to apply:** guard every handler on "would this actually change state?" and return early, and render the dead control as `disabled`/dimmed so it reads as inert. Don't take a preparatory side effect (measuring, pinning, re-fetching) on *open* when it's only needed on *change* — do it lazily, at the moment the change happens. If a mechanism has to alter layout to work, make the setup exactly reversible/invisible (measure → apply → re-measure → correct), not "close enough" — and verify the delta really converged before he looks ([[feedback_live_visual_debugging]]).
