---
name: project-transparent-image-bg
description: "Product images (esp. background-removed ones) must sit on var(--color-surface) (white), never var(--color-bg) — two similar-looking tokens, easy to pick the wrong one"
metadata: 
  node_type: memory
  type: project
  originSessionId: d793ae5f-e1dd-4f53-b9ce-47ef5cdb9574
---

Any container that directly wraps a product photo (card image-wrap, gallery thumbnail, quick-view/modal image area, dashboard gallery-editor slot) must use `background: var(--color-surface)` (#ffffff), not `var(--color-bg)` (#f7f8fa, a barely-different off-white) and not `background: none`/transparent.

**Why:** The seller-side bg-removal tool (`src/workers/bg-removal.ts`) produces images with a genuinely transparent background. If the wrapping container isn't opaque white, the removed background shows whatever's behind it instead — a faint gray tint (`--color-bg`) or the page/drawer color bleeding through (when `background: none`). User confirmed (2026-07-07): default must be white, sourced from the site's palette token (not a hardcoded hex) — no per-seller/per-product configurable background color is planned (would conflict with the "fixed platform template only, no per-seller theming" architecture rule), just a consistent white default.

**How to apply:** When touching any new or existing image-wrap/thumbnail CSS, grep for `background: var(--color-bg)` or `background: none` on that selector and switch to `var(--color-surface)`. Already fixed in this pass: `.product-card__img-wrap` (store.css), `.thumb-btn` ([productSlug].astro), `.pqv-img-area`/`.pqv-thumb` (ProductQuickView.astro), `#pm-img-wrap`/`.pm-thumb` ([slug].astro store modal), `.gallery-slot__img` (dashboard.css). Already-correct references to copy from: `.home-product-card__img-wrap` (home.css), `#main-img-wrap` ([productSlug].astro), `.thumb-wrap` (dashboard.css product list).

**Follow-up (2026-07-07): white-on-white needs an explicit separator.** Once the image-wrap and the card body are both `--color-surface`, the image silently merges into the card with no visible boundary — user flagged this as "looks like it's just part of the card, no separation, doesn't look good." Don't revert the white background to fix it (that reintroduces the gray-tint problem above) — instead add `border-bottom: 1px solid var(--color-border)` on the image-wrap itself, so the boundary is explicit regardless of what color sits behind the product photo. Applied to `.home-product-card__img-wrap`, `.product-card__img-wrap`, `.pqv-img-area`, `#pm-img-wrap`. Skip it where a border already exists some other way (e.g. `.pqv-thumbs` already has its own `border-bottom`; individual thumb buttons already have a full border on all sides).

**Missed spot, found later the same session:** the product page's own "related products" strip (`.related-card` in `[productSlug].astro`, ~line 499) had its image-wrap div using an inline `background:var(--color-bg)` — same bug, just missed in the first sweep because it's inline styles inside the .astro template rather than a CSS file. Fixed to `var(--color-surface)` + the `border-bottom` separator. **Lesson: when doing this kind of pass, grep inline `style="...background:var(--color-bg)..."` attributes too, not just `.css` files** — several of these bugs live in template-literal/inline styles (dashboard JS templates, `[slug].astro`'s `pm-*` modal, this related-card), not in stylesheets.
