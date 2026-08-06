---
name: project_svg_height_auto_trap
description: "reset.css `svg{height:auto}` overrides the height attribute — chart SVGs must pin height inline or SSR and client renders differ"
metadata: 
  node_type: memory
  type: project
  originSessionId: 27ebef2c-270b-4fae-85f3-57c84f84d406
  modified: 2026-07-31T12:15:19.164Z
---

`src/styles/base/reset.css` sets `img, picture, svg, video { height: auto }`. That beats an
SVG's `height="200"` **attribute**, so the rendered height comes from the viewBox ratio
instead. A chart with a fixed 640-unit viewBox in a 597px card rendered 186.6px tall, while
the same chart rendered at the measured width came out 200px — every chart grew 13.4px the
moment the client repainted, and the axis text was squashed 6% until then.

Fixed 2026-07-31: `chart-svg.ts` now emits `style="…;height:${height}px"` on all three chart
types; `tests/chart-svg.test.ts` locks it.

**Why:** this cost four rounds of chasing the wrong thing — the animation looked broken, then
looked like it restarted, then looked like it jumped, and every one of those was the height
swap underneath it. **How to apply:** an SVG whose size must not depend on its viewBox needs
the height as an inline style, not an attribute. When SSR and client render the same component
and something "jumps", compare the two rendered boxes before touching the animation.

Related: [[feedback_live_visual_debugging]], [[project_css_class_name_collision]].
