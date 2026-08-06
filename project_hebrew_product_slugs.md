---
name: project_hebrew_product_slugs
description: "Product slugs keep Hebrew (fixed 2026-08-02); machine-read URLs must percent-encode via url-base.ts#urlSegment"
metadata: 
  node_type: memory
  type: project
  originSessionId: 36e9b5a8-f9f4-47dc-a17c-25ee932a5cbd
  modified: 2026-08-01T21:42:06.735Z
---

Product slugs are derived from the product NAME — the seller never types one. Until 2026-08-02
`slugify` stripped `[^a-z0-9-]`, so a Hebrew name became `''` and every Hebrew-named product in a
store shared the base `product`, disambiguated by a counter: `/store/product`, `/store/product-2`,
`/store/product-3`. On a Hebrew marketplace whose sellers are not required to know English, that
was most of the catalogue losing the strongest keyword a URL carries ([[project_seo_priority]]).

Now `slugify` keeps `\p{L}\p{N}` — letters in any script — and still drops path-hostile characters
(`/ ? # %`, controls, invisible RTL/LTR marks) because none of those are a letter or a digit.

**The paired rule:** a browser encodes a Hebrew `href` by itself, so in-page links need nothing —
but every URL handed to a MACHINE must be percent-encoded per segment via `url-base.ts#urlSegment`:
sitemap `<loc>` (spec requires it), the product feed's `<link>`, and canonical/og:url. Verified
against Astro's own source that `fetch-state.js#computePathname` runs `validateAndDecodePathname`
(a `decodeURI`) before route matching — so the decoded Hebrew param matches the stored slug.
`decodeURI` does NOT decode `%2F`/`%3F`/`%23`, which is safe only because slugify can never emit
those characters.

**How to apply:** existing products keep their stored slug (slugify runs at creation only), so no
indexed URL moved — a mixed catalogue is expected and self-corrects as sellers add products. Never
build a store/product URL for a feed, sitemap or canonical by interpolating a raw slug. Related:
[[project_feed_silent_rejection_class]], [[project_store_readiness_gate]].
