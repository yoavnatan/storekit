---
name: project-store-favicon
description: "A shopper-facing store page wears the store's own icon in the tab; everything else keeps the platform D — and why the icon sizes are a SECOND map"
metadata: 
  node_type: memory
  type: project
  originSessionId: 642a285a-35e0-44bc-97c9-73b44c21a457
  modified: 2026-08-05T12:10:17.698Z
---

**Decided and built 2026-08-05** (the owner asked "מה עושים לגבי פאביקון של כל חנות?"). A
shopper-facing store page — `/[storeSlug]` and its product pages — emits the STORE's own icon as
`rel="icon"` + `rel="apple-touch-icon"`. Every other page keeps the platform's drawn D.

**Why:** it is the sovereignty rule the product is built on ("each store is sovereign, platform chrome
fades inside a store"). Six open tabs should be six shops, not six copies of us. The picture is the
one the shopper already met on the store card and in the header, so it is recognition, not a new
asset — and it is **zero-touch**: a store with no uploaded logo falls back to its generated mark
(`store-mark.ts`), so there is no "set your favicon" step anywhere and there must never be one.

**The gate is `storeSlug && !sellerMode`, NOT `storeMode`.** `storeMode` is the layout — thirteen
non-store pages ask for it. The seller's dashboard is deliberately excluded: it is the platform's tool
for running a store, not the store. Same trap as [[project_header_layout]]'s colour bar, same day.

**It is a CIRCLE in the tab, and deliberately NOT on the iOS home screen** (owner, 2026-08-05).
Round because a store's identity already is everywhere else here — StoreAvatar is always a circle,
since a rounded square with a border on `--color-surface` is byte for byte the product-thumbnail
recipe and reads as a THING rather than a WHO. The apple-touch icon stays square and opaque: iOS
applies its own rounded mask and composites transparency onto BLACK, so a round source arrives as a
circle with black corners. Uploads take `cdnCircle` (`r_max` + **`f_png`**, never `f_auto` — f_auto
can pick JPEG for a photo and JPEG has no alpha); the generated mark takes
`renderStoreMarkIconPng`, which needed `encodePngRgba` (colour type 6) in `png.ts`.

**Two things that look like tidy-ups and are not:**

- `STORE_ICON_FORMATS` is a **separate map** from `STORE_IMAGE_FORMATS`, which is not a list of
  available sizes — it is the COMPLETE set of ratios an ad asset group requires, and
  `storeAdCreative` submits every entry of it. Merging favicon sizes in would offer them to Google
  and Meta as ad creative. `STORE_RENDER_FORMATS` is the union, and only `/api/store-image` uses it.
- The icon goes through `cdnThumb`/`f_auto`, **never** the ad path's `cdnFill`, which forces `f_jpg`
  because scrapers send no usable `Accept` header. JPEG has no alpha, so a logo uploaded with a
  transparent background would arrive as a black square in the tab strip.

`tests/store-image.test.ts` holds both. Related: [[project_brand_logo]], [[feedback_image_optimization]].
