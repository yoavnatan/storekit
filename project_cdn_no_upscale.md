---
name: project-cdn-no-upscale
description: "How to ask Cloudinary for a fixed-ratio crop that refuses to upscale — a width ceiling then a ratio, chained (lib/cdn.ts#cdnBand)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2d18c7b8-b07b-45a1-8251-a3a3b0b0b7b4
  modified: 2026-08-05T16:55:08.008Z
---

A `w_`/`h_` pair is an **order**: Cloudinary meets it by inventing pixels when the upload is
smaller, so every banner rung above the seller's own resolution was softer AND heavier than their
file. `c_lfill` does not fix it (above the source it abandons the crop and returns the whole
uncropped photo), and `c_limit` alone cannot crop to a ratio.

The answer is two transforms chained, and the ORDER is the whole trick — `lib/cdn.ts#cdnBand`:

    c_limit,w_<w>/ar_<ratio>,c_fill,g_auto,f_auto,q_auto

Step 1 is a ceiling. Step 2 states the crop as a **ratio, not a pixel height**, so it has no box to
fill and cannot upscale either. Measured 2026-08-05 on the real store banner (1776x592): w_2048 went
from 2048x682 / 63KB to 1776x592 / 55KB; rungs at or below the source are byte-identical.

**This retires the old claim that the fix needed each seller's stored upload dimensions** — the CDN
already knows them, it just had to be asked in a form that lets it decline. Don't add a
`*_image_width` column for this.

`cdnThumb` deliberately keeps plain `c_fill`: its callers (cart/order/table cells) are boxes of an
exact pixel size that want filling. `cdnFill` too — an ad platform rejects a creative at the wrong
ratio. Related: [[project-cloudinary-cold-render-lcp]], [[project-store-image-source]].
