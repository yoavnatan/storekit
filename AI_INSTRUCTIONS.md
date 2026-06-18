# AI Instructions

Read this + `CURRENT_TASK.md` at the start of every session. Nothing else unless the task requires it.

---

## What we're building
A modular online store builder. The site itself is a live demo of the platform ("StoreKit"). Anyone can fork it, edit one config file, add products, and publish a working store in minutes.
**Top priorities: SEO + simplicity.**

## Hard rules
- No TypeScript, no Tailwind, no React/Vue. Plain JS + plain CSS + Astro only.
- Colors/fonts only via CSS variables from `store.config.js`. Never hardcode in components.
- File content always in English. Chat can be Hebrew.

## SEO rules
- All pages use `BaseLayout` → `Seo.astro`. Never add `<head>` tags directly in a page.
- Content pages (home, products, `[slug]`) = static. Server pages (checkout, admin, api) = `prerender = false`.
- Every product page has `JSON-LD` type `Product`. Every page has unique `title` + `description`.

## Project structure
```
src/config/store.config.js   ← brand, colors, nav, sections — edit here to change the store
src/data/products.js         ← catalog
src/layouts/BaseLayout.astro ← page shell (injects CSS vars from config)
src/components/Seo.astro     ← all meta/OG/JSON-LD
src/components/              Header, Footer, ProductCard, CartDrawer
src/lib/cart.js              ← localStorage cart + events
src/lib/auth.js              ← HMAC-signed cookie auth
src/pages/                   index, products/index, products/[slug], checkout, api/checkout, admin/*, 404
public/                      favicon, robots.txt, og image, product images
```

## Workflow
1. Read this file + `CURRENT_TASK.md`.
2. Do the work — read source files only if needed.
3. Update `CURRENT_TASK.md` (last session + next step) and append a line to **Session log** below.

---

## Session log
- **S3** Fixed cart `[hidden]` vs `display:flex` bug. Site redesigned as platform demo (StoreKit brand, hero, "how it works", plans as products).
- **S2** Translated all files to English.
- **S1** Built full scaffold: Astro, CSS vars, cart, auth, SEO, admin, checkout placeholder.
