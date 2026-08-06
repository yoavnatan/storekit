---
name: feedback_hover_light_not_tint
description: "Hover surfaces must be white + shadow; grey/tinted washes read as \"dirt\" to this user"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6adaf3ca-b612-4760-be66-704ac77655ae
  modified: 2026-07-28T11:25:52.063Z
---

For hover feedback on this site's `--color-bg` surfaces, use **white (`--color-surface`) plus a shadow**, never a grey or tinted wash. Tried a `--color-border` fill (rejected: too dark), then a halfway `color-mix` toward border (rejected: "looks like dirt"). White with `--shadow-xs`/`drop-shadow` was accepted.

**Why:** on `--color-bg` (#f7f8fa), white sits ~3 levels above the background and `--color-border` ~21 below — so *dimming* a white hover walks it straight through the background (invisible) before it starts reading again on the dark side, and everything on that side looks grimy rather than lit. Visibility on this palette comes from the shadow, not from tone. It is also the site's own tactile-depth language (see [[project_tactile_depth_expansion]]).

**How to apply:** need a hover to be more visible? Grow the lit area and add/strengthen the shadow — don't darken it. Watch for hover rules that fill with `--color-bg` (e.g. `.btn--ghost:hover`), which are invisible on any page whose background is already `--color-bg`. Related: [[feedback_no_stacked_hover_effects]], [[project_transparent_image_bg]].
