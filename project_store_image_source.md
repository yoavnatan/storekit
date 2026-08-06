---
name: project_store_image_source
description: Store avatar/banner keep the uncropped original in *_image_source (0012) so re-framing never crops a crop; why not a c_crop URL
metadata: 
  node_type: memory
  type: project
  originSessionId: bbab661f-8f8c-43e8-be67-9a4aeee14a87
  modified: 2026-08-05T13:31:01.040Z
---

The store avatar and banner store TWO uploads: the crop the site serves (`banner_image` /
`profile_image`) and the uncropped original beside it (`banner_image_source` / `profile_image_source`,
migration 0012, added 2026-08-05). Only `src/scripts/dashboard/store-image.ts` reads the source — every
public surface (storefront, feeds, OG, ad creatives) still reads the cropped column.

**Why:** with only the crop stored, "nudge the avatar inside the circle" is impossible — panning a
square image in a square viewport at zoom 1 moves nothing, so the seller's only lever is zooming
further in. The products tab has the same limit (it re-crops the delivered URL); the store images no
longer do.

**Rejected — do not re-propose:** baking the crop into the delivered URL as `c_crop`. `lib/cdn.ts`
treats a URL that already carries a transform as "already optimized" (`HAS_TRANSFORM`) and stops
resizing it, and `cdnFill` returns `''` for one — which hands ad platforms nothing. See
[[project_external_seam_contract]].

**How to apply:** the source is NOT a field in the per-field merge ([[project_multitab_concurrency]]).
`pairedImageSource` in `lib/store-image.ts` makes it follow whichever image the merge chose, and keeps
the stored one whenever the picture itself did not change — so a POST without the field can't strip it.
Anything new that pairs a derivative with its origin should do the same, not merge the two separately.

The crop tool's circular mask (`CropOptions.round`) is preview only: the blob is still the full square,
because StoreAvatar paints a square `object-fit:cover` and CSS rounds it — and `cdnFill` is `f_jpg`,
so real transparent corners would reach the feeds as a circle on black. See [[project_store_favicon]].
