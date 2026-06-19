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
- **Current state:** multi-vendor foundation — TypeScript throughout, seller auth (HMAC cookie), store CRUD (JSON files), public store pages with per-store color theming, seller dashboard with product management.
- **Target state:** full marketplace. Discovery layer (browse stores, search, cross-store recommendations), payments, cart per-store.

### Multi-vendor concepts to keep in mind
- Seller account → one or more stores
- Store = isolated config (name, colors, logo, products)
- Platform pages = discovery layer (homepage, category browse, store listing)
- Cross-store signals = related stores, trending products, category links

## Hard rules
- **TypeScript everywhere** (no plain `.js` files in `src/`). Astro frontmatter + lib + config + API routes all in `.ts`. No `any` — use proper interfaces or `unknown`.
- No Tailwind, no React/Vue. Plain CSS + Astro only.
- **All styles in `src/styles/`.** Never write `<style>` blocks inside Astro files — not in components, not in pages.
- **Colors only via CSS variables in `tokens.css`.** Never hardcode hex values in components. Never inject from JS.
- **No emoji in UI.** Use inline SVG icons (`aria-hidden="true"`, `currentColor`). Emoji are not indexable.
- File content always in English. Chat can be Hebrew.

## SEO rules
- All public-facing pages use `BaseLayout` → `Seo.astro`. Never add `<head>` tags directly.
- Content pages = static (`prerender` default). Server pages (checkout, admin, seller, api) = `prerender = false`.
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
src/config/store.config.ts      ← platform config + PlatformConfig interface + formatPrice
src/data/products.ts            ← demo platform product catalog (plans) — separate from store products
data/sellers.json               ← seller accounts (email, password hash)
data/stores.json                ← store records (slug, name, colors, tagline…)
data/store-products.json        ← per-store products (storeId field)
src/layouts/BaseLayout.astro    ← page shell — accepts isLoggedIn, hasStore props → passed to Header
src/components/Seo.astro        ← all meta/OG/JSON-LD
src/components/Header.astro     ← nav changes based on isLoggedIn/hasStore props
src/components/Footer.astro
src/components/ProductCard.astro ← platform plan cards (demo products)
src/components/CartDrawer.astro  ← slide-in from right, confirm modal on item remove
src/components/ConfirmModal.astro ← global <dialog> confirm modal, event-driven (confirm:open)
src/lib/cart.ts                 ← CartItem interface + localStorage cart + events
src/lib/auth.ts                 ← original admin HMAC-cookie auth
src/lib/seller-auth.ts          ← Seller interface + registerSeller, loginSeller, set/get/clearSellerSession
src/lib/stores.ts               ← Store/StoreColors interfaces + createStore, getStoreBySellerId, getStoresBySellerId, getStoreBySlug, getAllStores, updateStore
src/lib/store-products.ts       ← StoreProduct interface + createProduct, getProductsByStoreId, getProductById, updateProduct, deleteProduct
src/workers/bg-removal.ts       ← Web Worker: BG removal via @imgly/background-removal (runs off main thread)
src/pages/index.astro           ← SSR; shows welcome-back if hasStore, marketing landing if not
src/pages/products/[slug].astro ← static demo product pages
src/pages/store/[slug].astro    ← SSR; public store page with per-store products grid
src/pages/seller/               ← register, login, dashboard (SSR, all pass isLoggedIn/hasStore to BaseLayout)
src/pages/seller/dashboard.astro ← multi-store tabs, store settings, product management (add/edit/delete)
src/pages/api/product.ts        ← JSON API: add-product, edit-product, delete-product (used by dashboard AJAX)
src/pages/api/store.ts          ← JSON API: save-settings (used by dashboard AJAX)
src/pages/admin/                ← original admin dashboard
src/pages/checkout.astro        ← placeholder
src/styles/
  main.css                      ← single CSS entry point — imports everything in order
  base/tokens.css               ← CSS variables — edit here to change colors/spacing
  base/reset.css
  layout/container.css          ← .container, .grid, .flex, .section
  components/buttons.css        ← .btn (accent color), .btn--ghost, .btn--sm, .btn--danger
  components/cards.css          ← .card
  components/forms.css          ← .field, .input
  components/header.css
  components/footer.css
  components/cart-drawer.css
  components/product-card.css
  components/confirm-modal.css  ← <dialog> confirm modal styles
  pages/home.css                ← hero, steps, welcome-back
  pages/auth.css                ← login/register
  pages/dashboard.css           ← seller dashboard
  pages/store.css               ← public store page + store product cards
  pages/checkout.css
  pages/product.css             ← demo product page
  pages/admin.css
  utilities/utils.css           ← .muted, .badge, .center, .visually-hidden
public/                         favicon, robots.txt, product images
```

## Build status
- [x] Astro + Node SSR adapter, static/SSR split
- [x] Single CSS entry + tokens.css color system — all styles in src/styles/, never in Astro files
- [x] SEO: Seo.astro, sitemap, JSON-LD, semantic HTML
- [x] Cart (localStorage) + CartDrawer + checkout placeholder
- [x] SVG icons everywhere (no emoji)
- [x] Homepage — shows marketing landing for guests, welcome-back for logged-in sellers
- [x] Seller auth: register / login / session (HMAC cookie)
- [x] Seller dashboard: edit store settings (name, tagline, description) — color picker removed (not relevant yet)
- [x] Multi-store: seller can create multiple stores, switch between them in dashboard
- [x] Store data persisted in data/stores.json
- [x] Seller product management: add / edit / delete products per store (data/store-products.json)
- [x] Public store page /store/[slug] — shows store's own products in a card grid
- [x] Nav is session-aware: shows Dashboard when logged in, hides Log in
- [x] Footer always at bottom (flex sticky footer pattern)
- [x] Store page (`/store/[slug]`) has store-mode header: no platform nav, user icon dropdown (Dashboard + Log out) for logged-in sellers
- [x] All store links from seller interface open in new tab (`target="_blank"`)
- [x] Button colors unified to `--color-primary` (green) across all components
- [x] Dashboard mutations (add/edit product, save settings) via AJAX — no page reload, DOM updated in place
- [x] All dashboard status messages auto-hide after 3 seconds
- [x] Add to cart button on store product cards — opens cart drawer via cart:open event
- [x] "New" badge on products added today (createdAt compared to today)
- [x] Store page hides stock count (shows "Out of stock" only when stock = 0)
- [x] Cart drawer slides in from right with CSS transform animation
- [x] Modern confirm modal (global <dialog>, ConfirmModal.astro) for delete product and cart item remove
- [x] Delete product via AJAX with confirm modal — DOM updated in place, no page reload
- [x] Product image upload: Cloudinary unsigned upload, placeholder SVG if no image, image shown in store cards + cart drawer
- [x] Image widget in dashboard: BG removal via Web Worker (@imgly), manual trigger, cached toggle (Keep original ↔ Restore removed BG), crop/zoom modal (cover mode, drag + scroll-wheel zoom, canvas render), Remove image with confirm modal
- [ ] Browse stores discovery page
- [ ] Payments

## Workflow
1. Read this file + `CURRENT_TASK.md`.
2. Do only what is listed in `CURRENT_TASK.md → Your instruction`.
3. **At the end of every session** — when the user says something like "next session", "we're done", "end of session", or asks to wrap up — do ALL of the following without being asked:
   - Update **Build status** above (check completed items, add new ones if needed).
   - Update `CURRENT_TASK.md → Next` and `Recommended next step` with what's logical next.
   - Update **Project structure** above if any files were added or changed.
   - Append a line to **Session log** below summarizing what was built this session.
   - **Never change `Your instruction`** — only the user changes that.

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
- **S11** Seller product management: store-products.ts CRUD, dashboard product table (add/edit/delete), /store/[slug] shows live products. Multi-store: getStoresBySellerId, store tabs in dashboard, "+ New store" inline form. Nav session-aware (Dashboard / Log in toggle). Homepage: welcome-back view for logged-in sellers hides marketing content. CSS fully extracted from all Astro files into src/styles/pages/ and src/styles/components/. Button color unified to --color-accent (#4a7a96) everywhere.
- **S12** UI polish: buttons unified to --color-primary (green), dashboard tab hover fixed, footer sticky (flex column body), "Go to dashboard" button width fixed. Store links from seller interface open in new tab. Store page gets store-mode header: no platform nav, user icon dropdown (Dashboard + Log out) for logged-in sellers. Session-end workflow instruction added to AI_INSTRUCTIONS.
- **S13** Dashboard UX overhaul: tab hover flicker fixed. Color picker removed. Fixed form-resubmission bug (PRG). Product edit now opens inline (no URL change). Add-product + edit-product + save-settings all via AJAX (fetch → /api/product.ts, /api/store.ts) — DOM updated in place, no page reload. All status messages auto-hide after 3s. AJAX-first pattern saved to memory.
- **S14** Store page purchase UX: Add to cart button on product cards, "New" badge for products added today, stock count hidden (only "Out of stock" shown). Cart drawer refactored to slide in from right with CSS transform animation. Global ConfirmModal component (<dialog>) added to BaseLayout — used for dashboard delete-product (AJAX) and cart item removal. delete-product added to /api/product.ts. .claudeignore added. Bash/Edit/Write/Read/Skill all auto-approved in settings.local.json.
- **S15** Product image upload: Cloudinary unsigned upload, placeholder SVG in store cards + cart drawer. Image widget in dashboard: BG removal in dedicated Web Worker (@imgly/background-removal, off main thread), manual trigger with spinner, cached toggle (Keep original ↔ Restore removed BG without re-run), "Keep original" also cancels in-progress removal, crop/zoom modal (280px viewport, drag + scroll-wheel + slider, cover fit, canvas 512×512 output), Remove image with confirm modal. URL param cleanup (?saved, ?added) via history.replaceState.
