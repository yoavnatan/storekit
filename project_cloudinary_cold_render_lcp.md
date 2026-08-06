---
name: project_cloudinary_cold_render_lcp
description: "Cloudinary renders each transform lazily — ~0.80s cold, ~0.19s warm; changing a transform string resets every URL to cold, and LCP must be measured on a build, never the dev server"
metadata: 
  node_type: memory
  type: project
  originSessionId: dadb522e-d82a-453b-94a9-362fc35b8454
  modified: 2026-08-03T16:41:30.399Z
---

Cloudinary renders a given transform **on the first request for it**: measured 2026-08-03, ~0.80s before a byte moves, ~0.19s every time after. This dominates any LCP number on this site, and it produced a whole afternoon of confusing readings.

**The trap that cost the most time:** changing a transform string (adding a crop, changing a width) makes every existing URL cold again. The owner measured his store page at 2.77s → 4.56s → 2.95s while nothing was getting worse — he was hitting freshly-invented transforms, one per store. Say this out loud before he measures again.

**Two rules that follow:**
1. **Measure LCP on a production build, never the dev server** (`npm run build`, then `node ./dist/server/entry.mjs` on a spare port). Dev transferred 2189KB against prod's 753KB for the same page, and injects CSS via JS after first paint. Kill the old server before restarting or it serves an HTML/CSS hash pair from the previous build and every reading is nonsense — that happened here and produced "the CSS isn't applying" for ten minutes. See [[feedback_dev_server]].
2. **Warm at save time, never on the visitor.** `lib/image-derive.ts` HEADs the new URLs while the seller is already waiting on a save. Product images have done this since 2026-07-29; the **store banner** — bigger, above the fold, and the store page's actual LCP element — was missed until 2026-08-03, so the first visitor to every store paid the cold render. Anything with `warm*Derivations` must request the **byte-identical** URLs the markup does, which is why `BANNER_WIDTHS`/`BANNER_RATIO`/`LIGHTBOX_WIDTHS` live in `lib/cdn.ts` and not in the page.

With the transforms warm, on a build: store page ~830ms, homepage ~800ms, /stores ~716ms.

Related: [[feedback_image_optimization]] (the cover-box crop rule found in the same pass), [[project_sequential_await_latency]].
