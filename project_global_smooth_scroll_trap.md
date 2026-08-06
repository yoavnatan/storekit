---
name: project-global-smooth-scroll-trap
description: "reset.css sets scroll-behavior:smooth on the root, which silently defeats any rAF-driven scroll — animateScrollTo turns it off for the duration"
metadata: 
  node_type: memory
  type: project
  originSessionId: b5e234dd-acf4-4701-aafb-73201eace9d4
  modified: 2026-07-30T15:36:26.886Z
---

`src/styles/base/reset.css` declares `scroll-behavior: smooth` on the root. That applies to the POSITIONAL `window.scrollTo(x, y)` too, so a hand-written rAF loop that writes a new position every frame is really asking the browser to start a fresh native animation toward a point ~3px away, 60 times a second. Measured result (2026-07-30): a 380ms `animateScrollTo` covering 1200px moved 40px — a crawl, with no error anywhere.

**Why it matters:** `src/scripts/dashboard/scroll-utils.ts#animateScrollTo` exists specifically to keep the browser's animator out of scrolling (native smooth-scroll drifts `scrollX` off 0 on this RTL site), and it could not, silently, for as long as both existed. It now sets `scroll-behavior:auto` on the root for the duration and restores it via a reference count.

**How to apply:** any new JS that positions the window scroll must go through `animateScrollTo` — never a bare `scrollTo` loop, and never a second copy of the function (the store page had one, it drifted out of sync with the original, and it was deleted in favour of the import). If a scroll ever looks like it is crawling or ignoring its target, suspect this property first. Related: [[feedback_framework_native_first]].
