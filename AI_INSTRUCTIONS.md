# AI Instructions

Read this + `CURRENT_TASK.md` at the start of every session. Nothing else unless the task requires it.

---

## What we're building
A **multi-vendor internet mall** — a platform where sellers open and manage their own online stores, and shoppers can discover and move between them.

Two SEO surfaces:
1. **The platform itself** — discoverable, links between stores, drives traffic across sellers.
2. **Each store** — its own SEO identity (title, description, JSON-LD, sitemap), as if it were a standalone site.

The cross-store experience is the core product differentiator: recommend related stores, surface similar products, keep shoppers inside the mall.

## Vision & Mission

**Vision:** Enable anyone to open an online store easily and efficiently — one that generates profit, is fair, and is fully transparent.

**Mission:** Build a Hebrew-language digital shopping mall that removes the technological and financial barriers for small businesses through built-in automation, a clean minimalist management interface, and a fair success-based payment model (no fixed monthly fees; success fee only; each seller has their own separate checkout).

---

## The Physical Mall Model — our north star

Every product decision must be tested against one question: **does this match how a real, physical mall works?**

### The mapping

| Physical mall | This platform |
|---|---|
| Mall entrance & corridors | Homepage (`/`) — discovery, trending stores, search |
| Store storefront & window display | `/store/[slug]` — each store's own page, branding, products |
| Walking past a store and getting curious | Cross-store recommendations, related stores surfaced on the homepage and between stores |
| Picking items up as you walk | Unified cart — items from any store collected together, grouped visually by store |
| Each store's own cash register | Hybrid checkout — pay per store OR pay everything at once (system splits to each seller behind the scenes) |
| Mall directory / map | Browse page, category filters, store search |
| The mall's reputation = trust for small stores | Platform brand gives legitimacy to sellers who couldn't build it alone |
| Rent + % of sales → here: success-fee only | No fixed monthly cost; platform earns only when the seller earns |
| Store hours | Store active/inactive status |
| Foot traffic from the mall's location | SEO — platform discoverability drives traffic to individual stores |
| Store pulls you IN (window, smell, music) | Store page UX must create immersion: the customer should feel "in" the store, not "on a product listing" |

### Key behavioral rules derived from this model

1. **Each store is sovereign.** Its page, brand, and voice must feel like an independent business — not a template inside a directory.
2. **The mall is infrastructure, not the star.** Platform chrome (header, nav, footer) fades when you're inside a store. The store takes over.
3. **Discovery is serendipitous, not deliberate.** Cross-store signals (related stores, trending) appear naturally — not as popups or aggressive upsells. Like a window display you notice while walking by.
4. **One bag, grouped by store.** The cart is unified — a customer can add products from multiple stores into one bag. But inside the cart, items are clearly grouped under their store, like carrying separate store bags inside a single mall shopping bag. The customer always knows what came from where.
5. **Hybrid checkout — flexibility without friction.** Two payment paths exist side by side:
   - **Per-store payment:** pay only for one store's items (quick checkout from a single store, leaves others in the cart).
   - **Consolidated payment (Split Payment):** pay for everything in one transaction. Behind the scenes, the platform splits the payment — each seller receives their share directly, and the platform takes its commission. This is a marketplace model (Stripe Connect or equivalent).
   The default UX should surface per-store checkout first (keeps each store feeling like its own register), with consolidated checkout as a convenience option.
6. **The mall benefits when stores succeed.** Every platform feature that helps a seller sell more is also good for the platform. Never build features that extract value from sellers at the buyer's expense, or vice versa.

---

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
- **Tailwind CSS v4 for all new styling.** No React/Vue. Keep components as Astro server components (`.astro`) wherever possible. Existing CSS files are kept until touched; new code uses Tailwind utility classes only — do not add new CSS files or `<style>` blocks.
- **`<Image />` from `astro:assets` for all platform images** (product cards, store pages, public-facing content). External Cloudinary URLs are whitelisted in `astro.config.mjs`. The dashboard upload widget keeps `<img>` for live previews (blob URLs — Image component requires static src).
- **Colors in Tailwind theme via CSS variables from `tokens.css`**. Never hardcode hex values. In Tailwind classes, reference CSS vars with `[color:var(--color-primary)]` syntax or extend the theme.
- **No emoji in UI.** Use inline SVG icons (`aria-hidden="true"`, `currentColor`). Emoji are not indexable.
- **Lighthouse 100 target:** static pages where possible (`prerender` default), semantic HTML, proper `alt`/`width`/`height` on all images, lazy loading, no render-blocking resources, minimal JS.
- **Mobile-first:** design for 375px viewport first, scale up with `sm:` / `md:` / `lg:` breakpoints.
- **Modular Architecture (Encapsulation):** All new features must be self-contained modules. UI components handle display only; all DB/API/Cloudinary logic must live strictly in `/src/services/` or `/pages/api/`. No file should exceed 200 lines without being split. Progressive Tailwind migration: when touching an existing CSS file, convert it to Tailwind at that point.
- **Micro-interactions:** Every interactive element must have an intentional, purposeful hover/active/focus state. Use `transition` of 100–200ms. Good patterns: image scale on card hover, `scale(0.97)` on button press, shadow growth on card hover, smooth opacity shifts. Never border-darkening on hover — use shadow or background instead. Animations must have a logical reason (feedback, affordance, delight) — not decoration for its own sake.
- **Scalability (design for many sellers + buyers):** The platform must remain stable under concurrent load. Three non-negotiable rules: (1) **API routes must be stateless** — no module-level mutable variables, no in-process caches that accumulate across requests; (2) **JSON file storage is dev-only** — `data/*.json` is acceptable now, but every lib function must be written as a pure DB adapter (read/write, no side effects), ready to swap for SQLite/Postgres with no API change; (3) **No shared write state** — writes must be safe if two Node processes run simultaneously (no file-lock assumptions, no singleton patterns). Before adding any feature, ask: would this break if 1000 sellers and 10,000 buyers used it at the same time?
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
src/lib/store-products.ts       ← StoreProduct interface (uses images?: string[] array, up to 5) + createProduct, getProductsByStoreId, getProductById, updateProduct, deleteProduct
src/lib/gallery-widget.ts       ← esc + galleryWidgetHtml — shared between server (dashboard frontmatter) and client scripts
src/workers/bg-removal.ts       ← Web Worker: BG removal via @imgly/background-removal (runs off main thread)
src/scripts/dashboard/
  bg-worker.ts                  ← BG Worker singleton + removeBackgroundInWorker + cancelBgWorker
  cloudinary.ts                 ← cloudinaryUpload(blob, cloud, preset)
  status.ts                     ← showStatus (AJAX flash messages)
  crop-modal.ts                 ← crop modal state + initCropModal + openCropModal
  gallery.ts                    ← initGalleryWidget, resolveGalleryUrls, resetGallery
  products.ts                   ← buildRows, attachListeners, bindExistingRows, initAddProduct, initDeleteProduct, initTableSort
  ui.ts                         ← initSettingsForm, initFormToggles, initNewStoreForm, initSettingsCollapsible, initAutoHideStatus
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
  pages/store.css               ← public store page + store product cards + lightbox
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
- [x] Homepage — customer discovery page: search bar + store grid; seller CTA banner at bottom; "Your carts" chips bar (active store carts, client-side)
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
- [x] Full UI redesign: neutral slate blue-gray palette, Plus Jakarta Sans font, compact buttons, edge-to-edge cover images on product cards, micro-interactions (image zoom, button scale), no border-darkening hovers, dashboard tabs square + active has pointer-events:none
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
- [x] Multi-image support: up to 5 images per product (`StoreProduct.images: string[]`); gallery widget with 5 slots in dashboard; BG removal + crop available per slot via shared edit panel
- [x] Store page lightbox: click product image → full-screen viewer with prev/next arrows, keyboard nav (← → Esc), touch swipe
- [x] Tailwind CSS v4 installed + configured via `@tailwindcss/vite`; Cloudinary domain whitelisted for Astro `<Image />` component; hard rules updated (Tailwind-first, mobile-first, Lighthouse 100)
- [x] Dashboard right column: replace Store URL card with store summary card (product count, in-stock count, stock value, live link button)
- [x] Browse stores discovery page (`/`) — search + store grid + seller CTA banner
- [x] Per-store cart: `store_cart_v2_{slug}` in localStorage; CartDrawer grouped by store with per-store checkout button; global count in header badge (no flash via is:inline script)
- [x] Seller `name` field: added to Seller interface + registration form; welcome banner shows user name not store name
- [x] Store logo in store-mode header: shows store name, links back to `/store/[slug]` (keeps customer in store)
- [x] Unified UI theme: per-store color overrides removed; platform uses single tokens.css palette; store branding = logo + banner + product images only
- [x] Cart image sync: `syncCartImages()` in cart.ts — on store page load, refreshes image/name/price for all products in localStorage cart
- [x] "New" badge: refined pulse animation (single slow ring, infinite, align-self: flex-start so width = text width only)
- [x] Dashboard product table: sortable by Name / Price / Stock (click header toggles asc/desc, chevron indicator)
- [x] Dashboard settings section: collapsible accordion (starts closed, chevron rotates on open)
- [x] Dashboard section headings: 1.15rem (compact, distinct from body text)
- [x] Dashboard product rows: subtle hover state (bg: --color-bg on white card)
- [x] Store page: `dir="auto"` on product names, descriptions, store tagline/description — Hebrew → RTL right-aligned, English → LTR left-aligned
- [x] Store about section: `text-align: center` — aligned with the platform footer note
- [x] Store page: client-side product search (by name) + custom styled sort dropdown (Default / Name A→Z / Z→A / Price Low→High / High→Low / Newest first) — no page reload, "no results" empty state
- [x] Scalability as hard rule in AI_INSTRUCTIONS: stateless API routes, JSON files = dev-only (swap-ready for DB), no shared write state
- [x] Seller dashboard: `sellerMode` nav — hides platform nav links, hides cart, shows user icon dropdown (Dashboard + Log out)
- [x] Dashboard encapsulation refactor: 1248 → 403 lines; `<script>` block 800 → 25 lines; logic extracted to 8 modules (`src/scripts/dashboard/` + `src/lib/gallery-widget.ts`)
- [x] Vision & Mission + Physical Mall Model — documented in AI_INSTRUCTIONS.md as north star for all product decisions; includes store→platform mapping table and 6 behavioral rules
- [x] Cart grand total — `getGrandTotal()` in cart.ts; CartDrawer shows per-store subtotals + grand total + "Pay all stores" button when 2+ stores in cart
- [x] Cart icon alignment — qty buttons (−/+/trash) and close button centered with flex
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
- **S1–S14** Foundation built: scaffold, TypeScript migration, seller auth, multi-store, seller dashboard (AJAX), store product management, public store page, cart + drawer, confirm modal, SVG icons, CSS architecture, SEO/JSON-LD.
- **S15** Product image upload: Cloudinary unsigned upload, BG removal Web Worker (@imgly), crop/zoom modal (canvas 512×512), Remove image confirm.
- **S16** Multi-image gallery (up to 5/product, images[] model), store page lightbox (arrows, keyboard, swipe). Tailwind v4 installed + Cloudinary whitelisted in astro.config.
- **S17** Dashboard right column: store summary card (product count, in-stock, stock value, live link).
- **S18** Adopted permanent modular architecture rules (encapsulation, layer separation, SRP, ≤200 lines). Progressive Tailwind migration: convert on contact. "New" badge pulse animation (CSS keyframe, store.css).
- **S19** Full UI redesign: slate blue-gray palette (#2a3547 primary, #4870c0 accent, #f7f8fa bg), Plus Jakarta Sans font, compact buttons with scale(0.97) press, edge-to-edge cover images with zoom on hover, no border-darkening hovers anywhere, dashboard tabs square (radius) + active pointer-events:none, micro-interactions rule added to AI_INSTRUCTIONS.
- **S20** Customer discovery homepage (search + store grid + seller CTA banner). Per-store cart architecture (store_cart_v2_{slug}), CartDrawer grouped by store with per-store checkout. Cart badge no-flash fix (is:inline). Seller name field added. Store-mode logo links back to store. Unified platform theme (per-store color overrides removed).
- **S21** Cart image sync (syncCartImages on store page load). "New" badge refined (single slow pulse, text-width only). Dashboard: sortable product table (Name/Price/Stock), collapsible settings section, compact h2 headings, product row hover. Store page: dir="auto" bidi detection, about section centered.
- **S22** Store page: client-side product search + custom sort dropdown (6 options, chevron, aria-selected, click-outside close). Scalability added as hard rule (stateless APIs, JSON = dev-only, no shared write state). Seller dashboard: sellerMode nav (no platform links, no cart, user icon dropdown). Dashboard encapsulation refactor: 1248 → 403 lines, script 800 → 25 lines, extracted to 8 modules in src/scripts/dashboard/ + src/lib/gallery-widget.ts.
- **S23** Vision & Mission + Physical Mall Model added to AI_INSTRUCTIONS.md (mapping table + 6 behavioral rules, hybrid checkout model). Cart: icon alignment fixed (flex center on qty buttons + close button), grand total section added (shows when 2+ stores — per-store subtotals + "Pay all stores" CTA). `getGrandTotal()` added to cart.ts.
