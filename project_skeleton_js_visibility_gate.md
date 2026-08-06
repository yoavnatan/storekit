---
name: project-skeleton-js-visibility-gate
description: A shimmer/skeleton must never hold an image at opacity 0 until JS removes .is-loading — cached photos then sit invisible until the bundle runs
metadata: 
  node_type: memory
  type: project
  originSessionId: 618ced7c-5f89-4078-a244-0100a9fe0fda
  modified: 2026-08-04T08:26:07.919Z
---

Every card shimmer on the site used to sit ON TOP of the image (`::before`, z-index 2)
with the image held at `opacity: 0` until `initImageSkeletons()` removed `.is-loading`.
Measured on the homepage 2026-07-30, warm-cache refresh: all 85 images served from
browser cache (0 bytes, 0ms) and still invisible for ~700-820ms on a prod build,
~2.2s on the dev server — the wait was the page's JS module, not the images.

Fixed 2026-07-30: shimmer moved UNDER the image (z-index 0 + `position:relative;
z-index:1` on the img), `opacity: 0` rules deleted, in store-card.css, home.css,
search.css, store.css and product.css. JS still removes `.is-loading`, but only to
stop the animation. Warm refresh now paints at ~330ms.

**Why:** anything that hides already-loaded content behind a class only JS can remove
converts "images are slow" into a bundle-execution wait — and dev, with unbundled
modules, exaggerates it ~3x, so it reads as an image problem.

**How to apply:** a skeleton is a BACKDROP, never a cover. New shimmer → put it
behind the content and let the content paint over it. JS may stop the animation,
never reveal the pixels. Exception: an img with a deferred `data-src`/blank pixel
has no pixels to paint anyway — those stay JS-driven (`#sticky-mini-img-wrap`, `.pm-slide`).

**The other half, found 2026-08-03 — WHEN the shimmer may start.** Putting it under the
image has a consequence nobody planned for: a background-removed product photo is
transparent, so the animated band shows THROUGH the subject and reads as a skeleton
painted on the product. Owner reported it three times, on three surfaces. Neither the
tint nor the timing was the cause — instrumented every frame, wraps where the image had
loaded and the shimmer still ran came to **zero**. The real fault: `is-loading` is
rendered server-side on every non-eager tile, but those images are `loading="lazy"` and
most tiles sit HORIZONTALLY off-screen inside the shelves, so **78 tiles on the homepage
animated forever for images the browser had never requested**. A shimmer claims "this box
is fetching something"; nothing was in flight.

Fix, in `lib/img-skeleton.ts#initImageSkeletons`: strip the class on init, hand it back
via IntersectionObserver at `rootMargin: 250px` — about when the lazy fetch actually
starts. 78 → 0. Every surface now routes through that one helper; the store page and the
product page had hand-rolled copies that each carried the bug separately, which is the
tell that it was never a per-surface problem. Tint also softened to one
`--color-skeleton` token (12% → 7% of `--color-muted`) — it had been written out
identically in ten files.

**How to apply:** never render a shimmer for an image whose fetch has not begun. If the
image is lazy and the tile can be off-screen, the shimmer is lazy too.

**CLOSED 2026-08-04 — the third half, and why the 08-03 measurement said "zero".** The owner
reported it again. That "instrumented every frame → zero overlap" instrumentation ran INSIDE
`img-skeleton.ts`, so it was structurally blind to everything before the module executes — and
that window was the whole remaining bug: `is-loading` was rendered SERVER-SIDE, so it animated
from first paint until the page bundle downloaded, parsed and ran, while a cached or eager image
painted long before. Probe installed ahead of any page script: **96 of 97 homepage tiles
shimmering over an already-painted image, up to 726ms, up to 3.9s at 4x CPU throttle.** Lesson
worth more than the fix: **instrumentation that lives inside the thing it measures cannot see the
thing it is late for.**

Fix: markup renders an inert `data-skeleton` marker; only the module ever adds the class.
`tests/skeleton-ssr-class.test.ts` fails on any server-rendered `is-loading` over an image with a
real `src` (the deferred `data-src` cases stay legal). Same sweep found the pattern surviving on
BOTH dashboards — seller products table (`.thumb-wrap`) and buyer order cards (`.o-thumb-wrap`),
each still holding photos at `opacity: 0` until JS; both now route through the module.

Second bug found while fixing it: `rootMargin` was 250px on the guess that lazy fetches start
about there. Chrome starts them far earlier, so tiles always hit `img.complete` and were skipped —
**the shimmer never fired at all**, i.e. the only one anyone ever saw was the false SSR one. Now
1600px: 12 tiles shimmer genuinely, post-load overlap still zero. A surface that "shows no bug"
may just be dead — check it still fires.

Unrelated but adjacent on the homepage: the first shelf's ~550ms `shelf-arrive` fade
(home.css) is deliberate and user-requested — see [[feedback-clean-design-line]].
Image delivery itself is fine — Cloudinary fetch, `max-age=604800`, see [[feedback-image-optimization]].
