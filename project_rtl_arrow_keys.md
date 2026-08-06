---
name: project_rtl_arrow_keys
description: "Arrow keys name a direction on screen, so RTL mirrors the horizontal pair; every handler goes through lib/arrow-step.ts"
metadata: 
  node_type: memory
  type: project
  originSessionId: d9dd40a2-9509-4661-84d5-438512505578
  modified: 2026-08-01T19:46:01.123Z
---

An arrow key names a direction **on screen**. The site renders RTL, so a
horizontal row runs right→left and `ArrowRight` must walk **backward** through
the source order to reach the item that is actually to the right. Written the
obvious way (`ArrowRight → index + 1`) it reads as correct in review and moves
the wrong way in Hebrew — nobody catches it until they drive the UI.

It shipped that way on the homepage tab strip and in two lightboxes, while the
product page had already solved the same thing inline off `pageLang === 'he'`.
Three copies, two of them wrong.

**How to apply:** `arrowStep(key, el)` in `src/lib/arrow-step.ts` returns +1 /
-1 / 0 in source-order terms, already mirrored. It keys off the element's
computed `direction`, not the language, so the language toggle needs no
rebinding. `tests/arrow-step.test.ts` greps `src/` and fails on any new
`'ArrowRight'` / `'ArrowLeft'` comparison that does not go through it. Vertical
arrows never flip — `direction` mirrors the inline axis only.

Sibling of [[project_flex_wrap_kills_scroller]] and
[[project_focus_ring_clipped_by_scroller]]: RTL and scroll containers are where
this codebase's UI bugs actually live.
