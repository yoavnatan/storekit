---
name: feedback-no-stacked-hover-effects
description: "Don't stack a darken/overlay hover effect on top of the tactile-depth shadow hover — pick one signal, not two"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d793ae5f-e1dd-4f53-b9ce-47ef5cdb9574
---

When a card/image already gets the tactile-depth shadow treatment on hover (`--shadow-card` → `--shadow-card-hover`, see [[project_tactile_depth_expansion]]), don't also add a separate darkening overlay (e.g. `background: rgba(0,0,0,0.04)` on a `::after`) on the image inside it. The user flagged this explicitly: stacking both effects reads as "the image got darkened" and feels off-brand, even when each effect in isolation seems subtle.

**Why:** Matches the existing hard rule "every animation needs a reason" — once the shadow already communicates hover/lift, a second darkening effect is redundant, not reinforcing. Found and removed in `.product-card__img-wrap--clickable:hover::after` (store.css) once the tactile-depth shadow was added to `.product-card` in the same session.

**How to apply:** Before adding any new hover feedback to a card/image, check whether the card *itself* already has a hover treatment (shadow, border-color, scale). If yes, don't add another one to a child element for the same hover — pick one.
