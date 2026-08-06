---
name: project_cart_store_sovereignty
description: Cart/wishlist store-sovereignty final design + the visual treatments the user rejected
metadata: 
  node_type: memory
  type: project
  originSessionId: a7e7a21c-d3c7-4631-8e73-c83e3b05fe72
  modified: 2026-07-27T09:26:50.713Z
---

Session ג׳: cart & wishlist give visual priority to the store the shopper is currently inside — that store's group floats to the top of both drawers (stable sort), and the rest sit under a muted **"מחנויות אחרות"** heading (underline sized to the text via `display:inline-block`). Shown whenever inside a store, even if the current store has nothing in the cart. No hr before that heading (it IS the separator); current group gets a small `margin-bottom` instead.

Current store detected via `<body data-store-slug>` (BaseLayout, server-resolved) — NOT URL parsing. The old `/store/[slug]` regex was dead after the root-URL migration; same dead regex also fixed in the store-page scroll-restore anti-flash IIFE. See [[project_cart_auth_session]].

**Rejected visual treatments (don't re-propose these — the user iterated through and killed each):**
- Accent pill/badge chip next to the store name — "מכוער".
- Vertical accent side-rule on the group — shifts items sideways / takes space, disliked even when flush to edge.
- Top+bottom border bracketing the group — "נורא ואיום".
- A "מחנות זו" heading over the current store — dropped as redundant beside "מחנויות אחרות" (kept the i18n key `inThisStore`, currently unused).

Colour when a rule is used = `--color-primary` (navy), the user explicitly said NOT the blue accent.
