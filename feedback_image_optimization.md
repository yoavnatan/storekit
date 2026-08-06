---
name: feedback_image_optimization
description: "Standing rule — images must self-optimize everywhere via src/lib/cdn.ts; never wait to be told again, never hand-roll lazy loading"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e2466b3a-647d-4549-a82a-fe4cd0f75e12
  modified: 2026-08-03T15:32:12.546Z
---

Images must optimize themselves as a property of the codebase, not as something the user re-asks for. He said it explicitly (2026-07-28): "I don't want to repeat this instruction — it recurs across the project in a different place every time."

**Why:** it kept regressing per-surface. A raw source URL painted into a small cell is wrong twice: ~8x the bytes it needs, and the source host controls caching (the demo host `cdn.dummyjson.com` sends `cache-control: no-store`, so every refresh re-downloaded everything — that was the reported "images take forever + skeletons come back on refresh"). Measured on the homepage: 3.88MB → 343KB across 69 tiles.

**How to apply:**
- Every image URL goes through `src/lib/cdn.ts` — `cdnSrc(url,w)` responsive/hero (+`cdnSrcSet`+`sizes`), `cdnThumb(url,w,h)` for any fixed-size cell (pass 2x the CSS size), `cdnCropSrcSet(url,widths,ratio)` for a responsive FIXED-ASPECT box, `cdnFill` for off-site consumers. It handles non-Cloudinary hosts too, via Cloudinary fetch delivery.
- **`object-fit: cover` + an uncropped source = bytes bought and thrown away (2026-08-03).** The box discards every pixel outside its aspect ratio AFTER paying to download and decode them, and sellers upload whatever shape they like. Whenever an `<img>` is `cover` inside a fixed-ratio frame, crop at the CDN (`cdnCropSrcSet` / `cdnThumb`), never `cdnSrc`. Found via the store banner — a 3/1 frame fed square photos: 84.5KB→32.2KB at w_1600, and it was the page's LCP element at 2.77s. Same waste, smaller, in `StoreCard`'s 80x80 preview cells. `g_auto` is what makes the crop safe (Cloudinary picks the window from the content, so the subject isn't centre-cropped out).
- **An LCP image also wants a `<head>` preload, ahead of the font preloads** (`BaseLayout`'s `preloadImage` prop). The scanner finds the `<img>` only after parsing the header, by which point the ten Heebo files hold the connections. The trap: preload and `<img>` must request the byte-identical `href`/`srcset`/`sizes`, or the browser downloads it twice — call the same helper with the same constants on both sides rather than sharing a variable (the guard test wants the helper visible at the markup anyway).
- Every `<img>` gets `loading` + `decoding`; LCP/above-fold gets `loading="eager"` + `fetchpriority="high"`.
- Never hand-roll lazy loading with `data-lazy-src` + IntersectionObserver — a src-less `<img>` is invisible to the preload scanner, so nothing loads until JS runs. Native `loading="lazy"` is the answer.
- `tests/image-optimization.test.ts` enforces all three over `src/**`. If it fails, fix the markup, not the allowlist. This test is what makes the rule stick — keep it green, don't delete it.
- Same spirit as [[feedback_framework_native_first]] (native lazy beat the hand-rolled observer) and [[feedback_architecture]] (one black box owns the concern).
