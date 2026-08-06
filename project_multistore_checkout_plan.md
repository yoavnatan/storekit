---
name: project_multistore_checkout_plan
description: "Agreed 2026-08-06 — a cart spanning N stores is checked out ONE STORE AT A TIME, never a queue of N payments; wallets make it painless, and a 'pay for everything' button layers on top if a token turns out to cross sellers"
metadata: 
  node_type: memory
  type: project
  originSessionId: bb2acdb1-3007-45d5-8d0a-69ccd293715e
  modified: 2026-08-06T19:46:04.176Z
---

Forced by [[project_payme_api_verified]]: one PayMe sale = one seller, and the card token looks
seller-scoped too, so a cart spanning N stores is N charges. **N is not bounded** — "three" was only
his example, and he said so explicitly.

**The design, and the reframe that made it work:** do NOT model it as "one cart that splits into N
payments". A queue of N scares a buyer off and gets worse the bigger the cart. Model it as **one
store in front of the buyer at any moment**:

- The cart shows the current store with its own basket and a single pay button; the rest are folded
  underneath ("יש לך עוד פריטים ב-N חנויות") — exactly the store-sovereignty cart design already
  chosen ([[project_cart_store_sovereignty]]).
- **Never render "לתשלום (8 חנויות)".**
- Each payment closes a **whole, valid order** on its own. Stop after the second and you have two
  real orders; the rest stays in the cart (server-side for a signed-in buyer,
  [[project_cart_auth_session]]). No partly-paid order, no stranded money — safer than a unified
  cart, not less safe.
- Buyer details are collected **once** and reused for every payment; no form repeats.
- One summary screen at the end plus one email covering all the orders.
- **Wallets decide the experience:** Apple Pay / Google Pay / Bit are supported, so N payments are
  N Face-ID taps rather than N card entries.
- **If a cross-seller token turns out to be allowed**, a "pay for everything" button layers ON TOP of
  the same route — card entered once, N charges in the background, one confirmation. Both modes
  coexist, so there is nothing to decide now and nothing thrown away.

**Why this is not the strategic loss he feared** (he asked directly: "אז מה מיוחד במרקטפלייס שלי?"):
one payment across sellers requires someone to collect and redistribute the money, and doing that
ourselves is a payment service needing a licence (GO_LIVE §3, ISA position paper). Every Israeli
marketplace without a licence hits the same wall — this was not a research failure or a weak
provider. The real differentiators are automatic advertising, SEO, the seller's own domain, money
paid straight to the seller, and zero-touch signup ([[project_zero_touch_selfservice]],
[[project_seo_priority]]).

Full write-up in `GO_LIVE_CHECKLIST.md` §3. Not built — waiting on sandbox keys
([[project_launch_three_conditions]]).
