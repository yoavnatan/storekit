---
name: project-sticky-scrollintoview-trap
description: "scrollIntoView on a position:sticky element scrolls the whole page to its unstuck position — the seller dashboard's refresh jump"
metadata: 
  node_type: memory
  type: project
  originSessionId: d8d31744-fcb5-4b7c-a90b-76fb03a67a45
  modified: 2026-07-31T12:28:18.482Z
---

`scrollIntoView({block:'nearest'})` on a `position:sticky` element is NOT a no-op when the
element looks visible: the browser targets the element's STATIC position, so it scrolls the
document back to where the element would sit unstuck. On the seller dashboard the sticky
`.dash-tabs` strip made every refresh read as down → up → down (browser restores scroll →
the call yanks to the top → the browser re-applies restoration a frame later). Diagnosed
2026-07-31 by sampling `window.scrollY` per rAF in Playwright, not by reading code.

**How to apply:** to keep a tab visible inside an overflowing strip, adjust the strip's own
`scrollLeft` by the visual overshoot (`window.__dashTabReveal` in DashTabsBoot.astro) — the
horizontal axis only, never `scrollIntoView`. Guarded by `tests/dash-tabs-boot.test.ts`.
The second half of the same bug: the page ALSO clicked the `?panel=` tab on load even though
the server had already rendered it open — a visible no-op ([[feedback-noop-interactions-invisible]]);
fire `dashtab:show` for the already-open panel instead. Related: [[feedback-subtle-scroll]],
[[project-global-smooth-scroll-trap]].
