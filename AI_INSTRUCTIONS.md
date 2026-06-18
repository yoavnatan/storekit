# AI Instructions

Read this + `CURRENT_TASK.md` at the start of every session. Nothing else unless the task requires it.

---

## What we're building
A **multi-vendor internet mall** — a platform where sellers open and manage their own online stores, and shoppers can discover and move between them.

Two SEO surfaces:
1. **The platform itself** — discoverable, links between stores, drives traffic across sellers.
2. **Each store** — its own SEO identity (title, description, JSON-LD, sitemap), as if it were a standalone site.

The cross-store experience is the core product differentiator: recommend related stores, surface similar products, keep shoppers inside the mall.

## Core priorities (in order)
1. **SEO-first** — every decision must support discoverability. Static pages, structured data, semantic HTML, fast load, no orphan pages. Both platform-level and per-store SEO must be strong independently.
2. **Automation-ready** — config-driven content, clean data shapes, separation of data and UI. Every feature should be triggerable programmatically (for future AI/API automation).
3. **Simplicity** — no abstractions beyond what the task requires.

## Architecture (current & target)
- **Current state:** multi-vendor foundation — TypeScript throughout, seller auth (HMAC cookie), store CRUD (JSON files), public store pages with per-store color theming, seller dashboard.
- **Target state:** full marketplace. Per-store product catalogs, discovery layer (browse stores, search, cross-store recommendations), payments.

### Multi-vendor concepts to keep in mind
- Seller account → one or more stores
- Store = isolated config (name, colors, logo, products)
- Platform pages = discovery layer (homepage, category browse, store listing)
- Cross-store signals = related stores, trending products, category links

## Hard rules
- **TypeScript everywhere** (no plain `.js` files in `src/`). Astro frontmatter + lib + config + API routes all in `.ts`. No `any` — use proper interfaces or `unknown`.
- No Tailwind, no React/Vue. Plain CSS + Astro only.
- **Colors only via CSS variables in `tokens.css`.** Never hardcode in components. Never inject from JS.
- **No emoji in UI.** Use inline SVG icons (`aria-hidden="true"`, `currentColor`). Emoji are not indexable.
- File content always in English. Chat can be Hebrew.

## SEO rules
- All public-facing pages use `BaseLayout` → `Seo.astro`. Never add `<head>` tags directly.
- Content pages = static (`prerender` default). Server pages (checkout, admin, api) = `prerender = false`.
- Every product page: `JSON-LD` type `Product`. Every store page: `JSON-LD` type `Store` or `LocalBusiness`.
- Every page: unique `title` + `description`. No duplicate meta.
- Semantic HTML always: `<article>`, `<section>`, `<nav>`, `<main>`, `<header>`, `<footer>`.
- All images: `alt`, `width`, `height`, `loading="lazy"`, `decoding="async"`.

## Automation rules
- All content (copy, products, nav, footer) from config or data files — never hardcoded in components.
- Data shapes must be clean and serializable — no DOM logic at the data layer.
- Think ahead: could this be populated by an AI agent or external API? Design the interface to allow it.

## Project structure (current)
```
src/config/store.config.ts      ← platform config + PlatformConfig interface
src/data/products.ts            ← demo product catalog + Product interface (will be per-store)
data/sellers.json               ← seller accounts (email, password hash, salt)
data/stores.json                ← store records (slug, name, colors, tagline…)
src/layouts/BaseLayout.astro    ← page shell
src/components/Seo.astro        ← all meta/OG/JSON-LD
src/components/                 Header, Footer, ProductCard, CartDrawer
src/lib/cart.ts                 ← CartItem interface + localStorage cart + events
src/lib/auth.ts                 ← original admin HMAC-cookie auth
src/lib/seller-auth.ts          ← Seller interface + registerSeller, loginSeller, set/get/clearSellerSession
src/lib/stores.ts               ← Store/StoreColors interfaces + createStore, getStoreBySellerId, getStoreBySlug, getAllStores, updateStore
src/pages/index.astro           ← seller-focused homepage (CTA, "how it works")
src/pages/products/[slug].astro ← static demo product pages (will evolve)
src/pages/seller/               ← register, login, dashboard, logout (SSR)
src/pages/admin/                ← original admin dashboard
src/pages/checkout.astro        ← placeholder
src/styles/
  main.css                      ← single CSS entry point
  base/tokens.css               ← CSS variables (edit here to change colors)
  base/reset.css
  layout/container.css          ← .container, .grid, .flex, .section
  components/buttons.css        ← .btn, .btn--ghost, .btn--accent
  components/cards.css          ← .card
  components/forms.css          ← .field, .input
  utilities/utils.css           ← .muted, .badge, .center, .visually-hidden
public/                         favicon, robots.txt, product images
```

## Build status
- [x] Astro + Node SSR adapter, static/SSR split
- [x] Single CSS entry + tokens.css color system
- [x] SEO: Seo.astro, sitemap, JSON-LD, semantic HTML
- [x] Cart (localStorage) + CartDrawer + checkout placeholder
- [x] SVG icons everywhere (no emoji)
- [x] Homepage — seller-focused landing page
- [x] Seller auth: register / login / session (HMAC cookie)
- [x] Seller dashboard: edit name, tagline, description, colors
- [x] Store data persisted in data/stores.json
- [x] Public store page /store/[slug]
- [ ] Seller product management (per-store products)
- [ ] Browse stores discovery page
- [ ] Payments

## Workflow
1. Read this file + `CURRENT_TASK.md`.
2. Do only what is listed in `CURRENT_TASK.md → Your instruction`.
3. At the end of every session:
   - Update **Build status** above (check completed items).
   - Update `CURRENT_TASK.md → Next step` and `Recommended next step` with what's logical next.
   - **Never change `Your instruction`** — only the user changes that.
   - Append a line to **Session log** below.

---

## Session log
- **S1** Built full scaffold: Astro, CSS vars, cart, auth, SEO, admin, checkout placeholder.
- **S2** Translated all files to English.
- **S3** Fixed cart bug. Site redesigned as platform demo (StoreKit brand, hero, "how it works", plans as products).
- **S4** CSS architecture refactor: `main.css` single entry point, split into `base/`, `layout/`, `components/`, `utilities/`.
- **S5** Color scheme green/orange. All emoji → inline SVG icons. AI_INSTRUCTIONS updated.
- **S6** Product cards redesigned: SVG icon + orange price, no images. Orange used in CTA, price, badges. Color system moved to `tokens.css` as single source of truth (removed BaseLayout injection).
- **S7** Project vision clarified: multi-vendor internet mall, not single store builder. AI_INSTRUCTIONS rewritten to reflect real architecture goal.
- **S8** CURRENT_TASK.md trimmed to current+next step only. Build status + full project structure moved into AI_INSTRUCTIONS. Built /store/[slug] SSR page with per-store color overrides + JSON-LD. Dashboard now links to live store.
- **S9** Full TypeScript migration: tsconfig.json, @types/node, all lib/config/data/API files converted to .ts with proper interfaces (CartItem, Store, Seller, Product, PlatformConfig). Build passes clean.
- **S10** Verified zero `any` types. Fixed AI_INSTRUCTIONS: architecture updated to reflect current multi-vendor state, workflow rule added (only user changes "Your instruction"), no-any rule added to Hard rules.
