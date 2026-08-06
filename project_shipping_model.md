---
name: project_shipping_model
description: "Shipping is platform-only (our carrier); prices platform-set; seller's sole lever is self-pickup"
metadata: 
  node_type: memory
  type: project
  originSessionId: c63f5679-21b9-4352-919b-9d51c03910cb
  modified: 2026-07-27T13:46:15.455Z
---

Decided 2026-07-27: **platform-only shipping** — every store ships through us. The user **explicitly rejected the hybrid** (a seller-own-shipping mode alongside ours). Because the store *receives* shipping as a service, **the seller never sets shipping prices and never profits from shipping**; their only lever is the free `selfPickup` toggle.

How it's implemented (rates in `lib/shipping.ts`, the checkout dropdown, server-side re-validation, the `lib/payment.ts` seam) is described in AI_INSTRUCTIONS → Checkout; don't restate it here.

Deferred to Sendit (GO_LIVE §5): exact pickup-point selection, real label/tracking, and a "free shipping" promo (needs carrier billing). See [[project_order_automation]].

**How to apply:** don't add per-seller shipping pricing or a seller-own-shipping mode without re-opening this decision with the user. Prices live in `lib/shipping.ts` only — one place, change once.
