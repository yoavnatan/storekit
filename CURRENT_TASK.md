# Current Task

> Write your task under **Your instruction**, then say "read current_task and go".

---

## Your instruction
*(write here)*

---

## Last session
Fixed cart close button (`[hidden]` CSS bug). Redesigned homepage as platform demo — StoreKit brand, hero, "how it works", plans as products.
**Files:** `reset.css`, `store.config.js`, `products.js`, `index.astro`, `AI_INSTRUCTIONS.md`, `public/products/*.svg`

## Next step
- `npm run dev` → verify cart opens/closes
- Wire Stripe payments, or build product editing in admin UI

## Status
- [x] Scaffold — Astro, plain CSS, plain JS
- [x] Modular config + SEO (sitemap, JSON-LD, Seo.astro)
- [x] Cart + drawer, checkout page, Stripe placeholder
- [x] Admin login / dashboard / logout
- [x] Site as platform demo (StoreKit)
- [ ] Real Stripe integration
- [ ] Admin UI for editing products/settings
