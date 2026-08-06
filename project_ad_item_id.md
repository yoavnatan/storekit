---
name: project-ad-item-id
description: One id for the feed AND the dataLayer/fbq events — src/lib/ad-item-id.ts; the slug-as-id class was invisible from every screen
metadata: 
  node_type: memory
  type: project
  originSessionId: b76f4b5e-f65a-4cc6-8861-2f5b90c5aba6
  modified: 2026-08-04T18:48:11.854Z
---

**The id Google and Meta know a product by is the uuid, narrowed to a variant combo — never the
slug.** One definition, `src/lib/ad-item-id.ts`, used by the Merchant/Catalog feed AND by all four
`dataLayer`/`fbq` call sites. Two guard tests: `ad-item-id.test.ts` cross-checks the helper against
the real feed builder, `ad-item-id-call-sites.test.ts` greps `src/` and fails any call site that
builds an id itself.

**Why it is worth remembering as a CLASS (found + fixed 2026-08-04).** For months the feed sent the
uuid and every event sent the slug. The two never joined, so dynamic remarketing had no product and
"which products did my ads sell" had no answer — and **nothing anywhere would have shown it**: the
feed validated, the events fired, each side was internally consistent. It survived four call sites
because `{ id: slug }` reads perfectly well in isolation. Same root cause, second victim found the
same hour: `trackAddToCart` also sent that id to `/api/analytics/event`, which accepts **only a
uuid** and drops anything else without a word — so every first-party `add_to_cart` was recorded with
no product, and the admin Data tab's "top added"/"top abandoned" lists had **always** been empty.

The shape to watch for: **one identifier quietly doing two jobs across a boundary neither side
validates.** Where two systems must agree on a key and neither errors on a mismatch, the agreement
needs a shared definition plus a test that compares the two sides' real output — a unit test of
either side alone stays green forever.

Also settled: a slug can never be an id here. Migration 0001 measured **47 slugs shared across
different stores** (which is why `wishlist_items` keys by product id), and a slug follows the
product NAME, so a rename retires one id and invents another — to a feed that is a new product with
no approval history.

Related: [[project_ads_verification_plan]], [[project_feed_silent_rejection_class]], [[feedback_fix_dont_report]]
