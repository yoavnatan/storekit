---
name: project_flex_wrap_kills_scroller
description: "flex-wrap:wrap on a flex-direction:column parent makes children size to max-content, silently killing any inner overflow-x scroller"
metadata: 
  node_type: memory
  type: project
  originSessionId: 91fdc73e-5366-4d16-8a67-1da18c993a6a
  modified: 2026-07-30T12:19:25.132Z
---

`flex-wrap: wrap` on a **`flex-direction: column`** container stops `align-items: stretch`
from sizing children to the container width — in a multi-line flex container each line
is sized to its content, so the child resolves to its **max-content width** instead.

Any inner `overflow-x: auto` scroller then never has anything to scroll:
`scrollWidth === clientWidth`, so edge arrows driven by that comparison
(`lib/chip-scroller.ts`) stay correctly hidden and the overflow is just clipped by
`html { overflow-x: hidden }` — unreachable content, no error, nothing in the console.

**Why:** hit 2026-07-30 on /stores. `.stores-directory__chips` still carried
`display:flex; flex-wrap:wrap; gap` from the era when the chips really did wrap onto
several lines. It was left in place when the row became a scroller and reused
`.store-controls` (a column container), so the chip row measured 1571px inside a
1280px parent — 16 categories, most unreachable, on desktop and mobile alike.

**How to apply:** when a scroller row "just doesn't scroll", measure
`row.clientWidth` vs `row.scrollWidth` vs `parent.clientWidth` in a real browser
before touching the scroller JS — a child WIDER than its parent means the parent's
flex context is the bug, not the scroller. Reusing a layout class for its
spacing/chrome means the reusing class must add spacing ONLY; any layout property
in it fights the class it is reusing. Related: [[feedback_framework_native_first]],
[[project_tailwind_hidden_vs_flex]].
