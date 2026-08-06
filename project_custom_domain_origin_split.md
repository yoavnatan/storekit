---
name: project_custom_domain_origin_split
description: "DECIDED + BUILT — a custom domain is a second browser origin; browsing is the store's, the transaction is the platform's"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8d3cf059-ae06-4038-a1be-d9639a399dca
  modified: 2026-08-06T18:01:15.837Z
---

**Decided by him 2026-08-06, built the same session. Option א: checkout + login centralised on
`dezabin.co.il`.**

A seller's custom domain is a different browser origin, and two things do not cross it: the cart
(`localStorage`) and the session (`seller_session`, host-scoped — and it is the only account cookie,
buyers included). So crossing used to mean **logged out, empty cart, ad click lost**. The old
workarounds are dead: third-party cookies and cross-origin storage are blocked by Safari ITP and
Chrome storage partitioning.

**The rule: the store is sovereign for BROWSING, the platform owns the TRANSACTION.**

- `lib/platform-routes.ts` — import-free, shared by server and browser: which first segments are the
  platform's (`checkout`, `cart`, `buyer`, `seller`, `stores`, `search`, `terms`, …) and which belong
  to whichever host is serving (`api`, `_astro`, `robots`, `sitemap-content`, the store's own states).
  A guard test fails if a new `RESERVED_SLUGS` entry lands on neither list.
- Links are rewritten **in the page** (`custom-domain-links.ts`); the middleware 302s the same paths
  as a floor under a middle-click, a bookmark or a page whose script never ran.
- The cart crosses in the URL **fragment** (`lib/cart-handoff.ts`): never sent to a server, so no
  handoff table and no CSRF hole at the one route where money starts moving. Everything read back is
  untrusted and bounded; `mergeStoreCart` ADDS quantities and still clamps to stock.
- `sn_vid` + `sn_attr` cross in a **signed, 10-minute** query token (`lib/cross-origin-handoff.ts`).
  Signed because it names an ad click, and an ad click decides which campaign is credited with a
  sale. GA4's own cross-domain linking needs a hand-maintained domain list this model can never have.
- A page carrying a token sets `Cache-Control: private, no-store`, **from the frontmatter** — Astro
  streams the body, so a header set in a template expression is written too late.

**Why:** centralising checkout also FIXED a live hole — `/api/checkout` reads the attribution cookie,
written on the platform origin, so any purchase completed on a seller's domain was silently
unattributed. **How to apply:** anything new a shopper reaches from inside a store — a wishlist page,
an order-tracking link, a coupon flow — must be put on one side of this boundary on purpose.
Related: [[project_custom_domain_host_surfaces]], [[project_cart_store_sovereignty]],
[[project_cart_auth_session]], [[project_ad_platform_account_risk]].
