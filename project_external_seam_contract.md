---
name: project_external_seam_contract
description: The class where each side is right and only the join is wrong (feed/events/sitemap/canonical); 4 defects closed 2026-08-04 + the tree-wide guard that now fails on a new one
metadata: 
  node_type: memory
  type: project
  originSessionId: b7d0e793-b425-4e15-a3f0-a360d51c118c
  modified: 2026-08-04T20:02:30.235Z
---

**The seam = anywhere our data must satisfy a system that is not ours** (Merchant/Meta feed, dataLayer/fbq, sitemap, canonical, llms.txt, IndexNow, a `Location` header). The class: **each side is correct alone and only the JOIN is wrong**, so nothing reports it — the feed validates, the page renders, the event fires, and Google silently drops the row.

Focused scan run 2026-08-04 (6 commits, merged + pushed to main the same day) found **four live defects**, all invisible from every screen:

1. **A Hebrew redirect THROWS.** `Astro.params` arrives percent-DECODED (that is why DB lookups work); a header value is a byte string, so `new Response(null,{Location:'/נעל'})` throws → **500, not a wrong URL**. Hit the two slug-rename 301s, the product→store fall-back, the custom-domain 301. Fix: `url-base.ts#machineUrl` (idempotent), on EVERY interpolated `redirect()`.
2. **Feed `<link>` ignored an active custom domain** → cross-domain 301 → Merchant disapproval, for the most professional-looking sellers. Fix: the feed is handed `productCanonicalUrl` — the page's own canonical function, not a template.
3. **Merchant caps `id` at 50 chars.** uuid(36) + Hebrew combo = 53+ → every row of a Hebrew variant product rejected, and a variant product emits no parent row, so the product was **absent from the catalogue entirely**. Fix: hash the combo over the cap (never truncate — that collapses two combos onto one id).
4. **No feed attribute obeyed its published limit** (brand 70, mpn 70, colour 40, product_type 750, custom_label 100). Clamped in the feed, not at input — a store name is not an ad field until it becomes one. An over-length **identifier is DROPPED, never cut**.

**The permanent guard is `tests/external-contract.test.ts`** — the answer to "how do we not find the next one by accident". It runs an adversarially long Hebrew product through the real feed builder and **fails on a feed attribute it has never heard of**, so a new attribute cannot ship until its limit is written down; the redirect half is a tree-wide grep. Both halves mutation-checked. Limits verified against Google's published spec, not from memory.

**Meta is covered by the same table** — both specs were read: on every shared attribute Google's limit is the tighter one. The one thing no local test can settle (Meta spells `availability` with a space) is logged in GO_LIVE §2.5 with its fallback: a second endpoint, never an edit to the existing feed.

Reviewing my own diff caught an **open redirect I had just introduced**: encoding resolves dot segments, so `/..//evil.example` → `//evil.example`. In `safe-redirect.ts` the encode must come BEFORE the judgement, and the raw `//` check stays too.

Related: [[project_ad_item_id]] (the id that started this), [[project_feed_silent_rejection_class]], [[project_hebrew_product_slugs]], [[project_safe_redirect]].
