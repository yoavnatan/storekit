---
name: project_focus_ring_clipped_by_scroller
description: "A horizontal strip with overflow hidden slices the keyboard focus ring off its children; fix with a negative outline-offset, not padding"
metadata: 
  node_type: memory
  type: project
  originSessionId: d9dd40a2-9509-4661-84d5-438512505578
  modified: 2026-08-01T19:11:46.240Z
---

reset.css draws focus as `outline: 2px` at `outline-offset: 2px`, so the ring
lands **4px outside** an element's border box. Any strip that clips —
`overflow-x:auto` (which forces `overflow-y` to compute non-visible), an
`.edge-fade` mask, `overflow:hidden` — slices that ring off whenever its
children fill its height. The symptom is a stray line beside the focused item
rather than a ring, and it is invisible unless you actually Tab through.

Two fixes, and which one is right depends on whether the strip's height is
load-bearing:

- **Negative `outline-offset`** (`.dash-tab:focus-visible { outline-offset:
  -2px }`) — draws the ring inside the element. Zero layout change. Required
  for `.dash-tabs`, whose measured height feeds `--dash-tabs-h` and six sticky
  `top:` / scroll-offset consumers. Needs transparent-ish fill to stay legible.
- **`padding-block: Npx; margin-block: -Npx`** — buys bleed room without
  moving the row. Right for `.category-filters-row` and `.home-shelf`, where
  nothing measures the height, and the only option when the focused item has a
  solid fill (a pressed `.category-chip` is filled `--color-primary`, so an
  inset ring would vanish into it).

Removing a shadow is the usual way this regresses: the bleed budget reads as
shadow-only, gets deleted with the shadow, and takes the focus ring with it.
See [[project_review_gate]] and [[feedback_no_ambient_looping_motion]].
