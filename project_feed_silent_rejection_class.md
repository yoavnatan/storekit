---
name: project_feed_silent_rejection_class
description: Merchant/Catalog reject feed rows silently — the four holes found 2026-08-02 and where the guards now live
metadata: 
  node_type: memory
  type: project
  originSessionId: 36e9b5a8-f9f4-47dc-a17c-25ee932a5cbd
  modified: 2026-08-01T21:34:19.083Z
---

Google Merchant Center / Meta Catalog reject a bad feed row **without telling anyone**: the product
sits on the storefront looking fine and no ad ever runs behind it. Four holes were found and fixed
2026-08-02 (all in `src/lib/product-feed.ts`, guards in `tests/product-feed.test.ts`):

1. **XML-illegal characters kill the WHOLE feed, not one row.** C0 controls (except tab/LF/CR),
   U+FFFE/U+FFFF and lone surrogates cannot be escaped into legality — a numeric reference to them
   is just as illegal. One anywhere makes the document unparseable, so every store's products drop.
   A description pasted out of Word carries U+000B and nothing upstream strips it. `xmlText()` is
   the single choke point; both `xmlEscape` and `cdata` route through it.
2. **`description` is REQUIRED but defaults to `''`** — `api/product.ts` enforces only `name`.
   Falls back to the title now (never invented copy).
3. **No length caps** — title 150, description 5000. Clamp must not split a surrogate pair.
4. **`image_link` must be ABSOLUTE.** `sanitizeImageUrl` keeps a site-relative `/path` by design
   (correct for storage, wrong for a feed) — `toAbsoluteImageUrl` in [[project_attribute_escaping_xss]]'s
   module resolves it against the feed origin. A product ships if ANY image survives, and is skipped
   only when none does.

**Why:** all four are invisible from inside the app — the feed renders, the dashboard shows numbers
([[project_ads_verification_plan]] explains the numbers are mock), and only Merchant Center knows.

**How to apply:** anything new emitted into the feed goes through `xmlText`; any new required
Merchant attribute needs an empty-value fallback, not just a type. Sitemap is NOT exposed to this
class — its slugs are `[a-z0-9-]` only. Related: [[project_seo_priority]].
