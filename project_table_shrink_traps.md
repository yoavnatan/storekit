---
name: project-table-shrink-traps
description: "Why a table scrolls sideways in the mid-widths, and why a collapse-to-cards breakpoint must be a container query when the page has a sidebar"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0b6ef381-38de-47a7-a559-1b61e2124e19
  modified: 2026-08-05T16:54:34.587Z
---

Two separate traps, both hit on the messages table (2026-07-30, buyer dashboard):

1. **`max-width` on a `<td>` is ignored in the default auto table layout.** A cell with
   `white-space:nowrap` therefore has a min-content width of its ENTIRE text on one line, so the
   table overflows any container narrower than its longest message — at every breakpoint, not just
   mobile. `.msg-table__td--preview` had `max-width:220px` and still forced the table to 907px.
   Fix: `table-layout: fixed` + column widths on the **`<th>`s** (fixed layout reads widths from
   the first row only — a width on a `<td>` does nothing), and add `overflow:hidden` to every text
   cell or it spills into its neighbour instead. `products-table` already does this at ≤999px.

2. **A "collapse to cards below X" breakpoint keyed to the VIEWPORT is wrong on any page with a
   sidebar.** The buyer dashboard keeps a 220px sidebar down to 768px, so a 1024px viewport gives
   the table ~684px while the media query still says "desktop". Use `@container` with
   `container-type: inline-size` on the panel — and put it on an ancestor of BOTH the table and its
   `.table-toolbar`, because the toolbar carries sort/filter once `<thead>` disappears; if only the
   table flips, those controls exist nowhere.

3. **An `overflow-x:auto` wrapper clips visually but can still widen the DOCUMENT on this RTL site
   (2026-07-31, admin money journal).** The wrapper was scrolling correctly (`clientWidth` 328,
   `scrollWidth` 672) and `body.scrollWidth` was 375 — yet `documentElement.scrollWidth` read 679 at
   a 375px viewport, and Playwright's viewport screenshot showed the page shoved off to one side.
   `overflow-x:clip` and `isolation:isolate` do NOT fix it; `position:relative` on the wrapper does
   (so does `contain:paint`). Symptom to recognise: `documentElement.scrollWidth > clientWidth` while
   `body.scrollWidth` equals it. **Check `documentElement`, not `body`** — the bug had shipped
   unnoticed because body looked fine.

4. **A `table-layout: fixed` block scoped to ONE range leaves every other range on `auto` — and
   `auto` means the CONTENT decides the width (2026-08-05, seller products table).** The tablet
   block (≤999px) had had fixed layout + ellipsis for months; above it the table sized itself to
   its own min-content — 983px on the demo catalogue — against a panel of 918px at a 1000px
   viewport, so it overflowed between ~1000 and ~1082px. **The tell that it is this and not a
   layout regression: it appears "suddenly" with no CSS change**, because one seller adding one
   longer product name widens the table for the whole store. Fix is the same discipline on the
   other side of the breakpoint with its own shares, not a wider column. The breakpoint itself is
   legitimate — it is where the shares change (narrow: price/date can't ellipsize, so `name`
   yields; wide: `name` takes the most).

**Measure, don't eyeball:** a Playwright harness that links the real `tokens.css` + `utils.css` and
renders one row is enough to get the exact min-content width and the exact breakpoint. Related:
[[project-flex-wrap-kills-scroller]], [[project-css-class-name-collision]].
