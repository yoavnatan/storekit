---
name: project-tailwind-hidden-vs-flex
description: "In this project's built CSS `.flex` comes AFTER `.hidden`, so classList.toggle('hidden') silently fails on a flex element — use `!hidden`"
metadata: 
  node_type: memory
  type: project
  originSessionId: 454b6262-65e8-44ab-badf-274d904a06b3
  modified: 2026-07-29T09:15:41.196Z
---

In this repo's compiled Tailwind v4 output, `.flex` is emitted **after** `.hidden`, so both being same-specificity utilities, `flex` wins on source order. Toggling `hidden` on an element that also carries `flex` does nothing — computed `display` stays `flex`, no error anywhere.

Measured 2026-07-29 on `#co-grand-total-row` in [checkout.astro](src/pages/checkout.astro): `classList.toggle('hidden', …)` reported the class present while `getComputedStyle().display` was still `flex`. Fixed by toggling `'!hidden'` (`display:none !important`), which the codebase already uses the prefix-`!` form for elsewhere.

**How to apply:** any JS show/hide on an element whose class list includes `flex` (or `grid`) must toggle `!hidden`, not `hidden`. A quick isolated `@tailwindcss/cli` build gives the OPPOSITE order and will mislead you — check the real page with `getComputedStyle`, not a scratch build. Elements that are block by default (`<p>`, plain `<div>`) are unaffected.

Related: [[feedback_tailwind_image]], [[feedback_live_visual_debugging]].
