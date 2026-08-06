---
name: project_seller_seo_guidance
description: "The seller product form now tells the seller what to write — derived, state-free, and it gates NOTHING; built 2026-08-04 with brand + merchant-listing schema"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4f1f04d2-03e6-4b3b-a201-7550b6581636
  modified: 2026-08-04T07:00:07.465Z
---

**The gap the owner spotted (2026-08-04):** of the five things an SEO specialist does, "guidelines for the people uploading the content" was the only one with nothing behind it. The product form had no minimum description, no counter, no preview, no sign of which field affects ranking.

**What was built, and the shape it took:** [product-seo-hints.ts](src/lib/product-seo-hints.ts) — advice **derived from the product's own fields, state-free**, deliberately modelled on `seller-onboarding.ts` so there is nothing persisted and no way for the advice to disagree with the product. [product-seo-field.ts](src/lib/product-seo-field.ts) renders it plus a live search-result preview into BOTH product forms (same SSR/client-rebuild reason as `discount-field.ts`), and thin listings get a marker in the products table.

**Three decisions worth not re-litigating:**
1. **It gates nothing.** No overlay, no link off the page, nothing disabled, no blocked save. The owner's standing constraint, stated mid-build: *nothing may take the seller out of the flow or throw them off the site with no way back, especially on mobile.* Gating publication on prose length would also trade away the "a first product takes a minute" promise.
2. **Only the missing image is `required`** — and only because it is a FACT, not an opinion: `product-feed.ts` returns `[]` without an `image_link`, so the product cannot be advertised at all.
3. **`needsSeoAttention` is NOT "any hint open"** — it fires on the required item, or on 3+ open. A catalog sitting at 4-of-5 would otherwise wear a marker on every row, which reads as decoration and gets ignored.

**Also landed the same day:** `StoreProduct.brand?` (migration 0008) — the manufacturer's brand for a **reseller**; empty falls back to the store name exactly as the feed and JSON-LD always did. Merchant Center matches on brand, so a distributor's product wearing the shop's name never joins the real listing. Plus `shippingDetails` + `priceValidUntil` on the Offer and an `@graph` WebSite/SearchAction on the homepage.

**Two things the review caught, both of the class this repo keeps hitting:** the input mapping existed in two modules (now `productSeoInputFrom`, one home), and `addForm.reset()` fires no `input` event — so the panel kept describing the product that had just been saved.

**Still open and BLOCKED ON THE OWNER, not on code:** `hasMerchantReturnPolicy` needs a real returns policy (days + who pays return shipping), and `deliveryTime` inside `offerShippingDetails()` needs Sendit's real numbers. Both are rows in `GO_LIVE_CHECKLIST.md` §5. **Do not invent either** — in structured data a guess becomes a public promise.

Related: [[project_seo_priority]], [[project_zero_touch_selfservice]], [[project_client_renderer_i18n_drift]], [[project_platform_shelves_deferred]].
