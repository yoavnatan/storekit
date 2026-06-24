# AI Instructions

Read this + `CURRENT_TASK.md` at the start of every session. Nothing else unless the task requires it.

---

## What we're building
A **multi-vendor internet mall** — sellers open their own stores, shoppers discover and move between them. Two independent SEO surfaces: the platform (discovery, cross-store links) and each store (its own title, description, JSON-LD, sitemap — feels like a standalone site).

**Vision:** Anyone can open an online store easily — profitable, fair, fully transparent.
**Mission:** Hebrew-language digital mall. No fixed fees; success-based only. Each seller has a separate checkout.

---

## The Physical Mall Model — north star

Every product decision: **does this match how a real, physical mall works?**

| Physical mall | Platform |
|---|---|
| Entrance & corridors | `/` — discovery, trending, search |
| Store storefront | `/store/[slug]` — branding, products |
| Walking past, getting curious | Cross-store recommendations |
| One bag for all stores | Unified cart, items grouped by store |
| Each store's own cash register | Hybrid checkout: per-store OR consolidated (Stripe Connect) |
| Mall directory | Browse page, category filters |
| Mall reputation = trust | Platform brand gives legitimacy to small sellers |
| Foot traffic | SEO drives traffic to individual stores |
| Store pulls you in | Store page = immersion; customer feels "in" the store |

**Key rules:** (1) Each store is sovereign — independent business, not a template. (2) Mall is infrastructure, not the star — platform chrome fades inside a store. (3) Discovery is serendipitous — cross-store signals appear naturally, never as aggressive upsells. (4) One bag, grouped by store — customer always knows what came from where. (5) Hybrid checkout — per-store first (default), consolidated as convenience; platform splits payment behind the scenes. (6) Mall benefits when stores succeed — never extract value at buyers' or sellers' expense.

---

## Core priorities
1. **SEO-first** — static pages, structured data, semantic HTML, fast load, no orphan pages. Platform-level and per-store SEO independently strong.
2. **Automation-ready** — config-driven content, clean serializable data shapes, every feature triggerable programmatically.
3. **Simplicity** — no abstractions beyond what the task requires.

## Architecture
- **Stack:** Astro SSR + Node adapter, TypeScript throughout, Tailwind v4, Heebo font, `tokens.css` color system, static/SSR split (content pages = static, seller/admin/api = SSR)
- **Data:** `data/*.json` dev-only; every lib function is a pure DB adapter, swap-ready for SQLite/Postgres
- **Multi-vendor model:** Seller → one or more stores (isolated config: name, logo, products). Platform pages = discovery layer.
- **Target state:** payments, browse/search, cross-store recommendations

---

## Hard rules
- **TypeScript everywhere** — no `.js` in `src/`. No `any` — use proper interfaces or `unknown`.
- **Tailwind v4 for all new styling** — Astro server components only. No new CSS files or `<style>` blocks. Convert existing CSS on contact (progressive migration).
- **`<Image />` from `astro:assets`** for all platform images. Dashboard upload widget uses `<img>` for blob previews only.
- **Colors via `tokens.css` CSS variables** — never hardcode hex. Use `[color:var(--color-primary)]` in Tailwind arbitrary values.
- **No emoji** — inline SVG icons (`aria-hidden="true"`, `currentColor`). Emoji are not indexable.
- **Lighthouse 100 target** — `prerender` default for content pages, semantic HTML, proper `alt`/`width`/`height`, lazy loading, no render-blocking resources.
- **Mobile-first** — design for 375px viewport, scale up with `sm:` / `md:` / `lg:`.
- **Modular architecture** — UI = display only; all DB/API/Cloudinary logic strictly in `/src/services/` or `/pages/api/`. No file > 200 lines without splitting. SRP always.
- **Micro-interactions (non-negotiable)** — every interactive element must feel alive. Required: `scale(0.97)` on button `:active`; image `scale(1.06)` on card hover; shadow growth on hover; spring easing `cubic-bezier(0.34, 1.56, 0.64, 1)` for pop moments. Duration: 100–180ms hover, 220–320ms spring pops. No border-darkening — use shadow or background shift. Every animation needs a reason: feedback, affordance, or delight.
- **Scalability** — (1) stateless API routes (no module-level mutable vars, no in-process caches); (2) JSON = dev-only, pure swap-ready DB adapters; (3) no shared write state. Ask: breaks at 1000 sellers + 10,000 buyers?
- **Accessibility (WCAG 2.1 AA)** — skip link in BaseLayout (`#main-content`); focus trap + restore on all modals/drawers; all interactive elements keyboard-reachable (Escape closes overlays); ARIA labels/roles/`aria-expanded`/`aria-live` throughout; every input has a visible label; SVG icons `aria-hidden`; no `div`/`span` as buttons; 4.5:1 contrast minimum; never communicate state by color alone.
- **SEO** — all public pages via `BaseLayout → Seo.astro` (never `<head>` directly). JSON-LD `Product` on product pages, `Store`/`LocalBusiness` on store pages. Unique `title` + `description` per page. All images: `alt`, `width`, `height`, `loading="lazy"`, `decoding="async"`.
- **i18n** — all UI strings via `getT(lang)`. Hebrew-first. RTL/LTR via `dir` on `<html>`. Use server-side `lang` conditionals for icon placement — Tailwind `ltr:/rtl:` variants unreliable.
- **Content from config** — all copy, nav, footer from data/config files, never hardcoded in components.
- File content in English. Chat in Hebrew.

---

## Current feature inventory
- **Platform:** Astro SSR + Node, TypeScript, Tailwind v4, Heebo font, `tokens.css` palette, Cloudinary (whitelisted in astro.config)
- **Auth:** Seller register/login (HMAC cookie), seller `name` field; store-mode nav hides platform links; "כניסה" login button in header for non-logged-in users on all pages
- **Dashboard:** Multi-store tabs + store-switcher dropdown; AJAX product CRUD; sortable table (row #, stock warning icon); collapsible settings; store overview card; 8 script modules in `src/scripts/dashboard/`
- **Images:** Cloudinary upload; BG removal Web Worker (`@imgly`, `isnet_quint8`, resize to 1024px); crop/zoom modal (OffscreenCanvas); up to 5 images per product (`images?: string[]`); gallery widget
- **Store page `/store/[slug]`:** Product grid (no "מוצרים" heading); **product detail modal** (click image/name → modal; `history.pushState` syncs URL to `/store/slug/product`, `document.title` updates, `popstate` closes modal on browser back; ESC/backdrop close; image gallery with lightbox-from-modal; qty + add-to-cart + wishlist; direct URL → full SSR product page for SEO/sharing); lightbox (arrows/keyboard/swipe/touch); search + sort dropdown; add to cart (spring animation + qty stepper); wishlist hearts; "New" badge; `dir="auto"` bidi; **light banner** (white bg, store name + tagline + description) + **thin dark strip** (0.5cm, teal glow, RTL/LTR aware) that sticks below header on scroll (JS scroll listener + placeholder). Backup pre-modal at `_backup/store-slug.astro`
- **Product page `/store/[storeSlug]/[productSlug]`:** Main image + thumbnail switcher; lightbox on image click; qty stepper; add to cart; wishlist; related products row ("עוד מ-", horizontal scroll, qty+add-to-cart per card); back-link (← store name); BreadcrumbList JSON-LD + Product JSON-LD; SEO meta; low-stock indicator
- **Cart:** Per-store localStorage (`store_cart_v2_{slug}`); CartDrawer (grouped by store, per-store subtotals, grand total, "Pay all stores"); qty ripple; confirm modal on remove; `syncCartImages()`
- **Wishlist:** localStorage; WishlistDrawer (qty controls, two-step remove, cover images)
- **Homepage `/`:** Compact dark hero (search only); greeting bar below hero (logged-in only); per-store product carousels with scroll arrows (store title links to store); active carts section; seller CTA banner
- **i18n:** `he`/`en` dictionaries; `getLang`/`getT`; lang cookie; language toggle in header; RTL-aware throughout
- **SEO / A11y:** `Seo.astro`, JSON-LD (Store/Product/Organization), sitemap; skip link, focus traps, ARIA roles, keyboard nav, aria-live regions

---

## Project structure
```
src/i18n/translations.ts        ← he + en string dictionaries (all UI namespaces)
src/i18n/index.ts               ← getLang, getDir, getT
src/config/store.config.ts      ← platform config + formatPrice
data/sellers.json               ← seller accounts
data/stores.json                ← store records
data/store-products.json        ← per-store products (storeId field)
src/layouts/BaseLayout.astro    ← page shell (isLoggedIn, hasStore, storeMode props)
src/components/Seo.astro        ← all meta/OG/JSON-LD
src/components/Header.astro     ← nav (session-aware, storeMode-aware)
src/components/Footer.astro
src/components/CartDrawer.astro
src/components/WishlistDrawer.astro
src/components/ConfirmModal.astro ← global <dialog>, event-driven (confirm:open)
src/lib/cart.ts                 ← CartItem, localStorage cart, events, syncCartImages
src/lib/wishlist.ts             ← WishlistItem, localStorage wishlist
src/lib/wishlist-counts.ts      ← wishlist count badge sync
src/lib/ripple.ts               ← spawnRipple()
src/lib/seller-auth.ts          ← Seller interface, register/login/session
src/lib/stores.ts               ← Store interface, CRUD
src/lib/store-products.ts       ← StoreProduct interface, CRUD (images?: string[])
src/lib/gallery-widget.ts       ← shared gallery HTML/escape helper
src/workers/bg-removal.ts       ← BG removal Web Worker (@imgly)
src/scripts/dashboard/          ← bg-worker, cloudinary, status, crop-modal, gallery, products, ui
src/pages/index.astro           ← SSR homepage
src/pages/store/[slug].astro    ← SSR public store page (product modal experiment active)
src/pages/store/[storeSlug]/[productSlug].astro ← SSR product page (full UX: lightbox, related products, JSON-LD)
_backup/store-slug.astro        ← store page snapshot pre-modal (revert if needed)
src/pages/seller/               ← register, login, dashboard (SSR)
src/pages/api/                  ← product, store, wishlist, lang
src/styles/main.css             ← single CSS entry point
src/styles/base/tokens.css      ← CSS variables (colors, spacing, radius)
src/styles/base/reset.css
src/styles/layout/container.css ← .container, .section
src/styles/components/          ← buttons, cards, forms, header, footer, cart-drawer, confirm-modal, product-card
src/styles/pages/               ← home, auth, dashboard, store, product, checkout
src/styles/utilities/utils.css  ← .muted, .badge, .visually-hidden
```

---

## Workflow
1. Read this file + `CURRENT_TASK.md`.
2. Do only what is in `CURRENT_TASK.md → Your instruction`.
3. **End of session** (trigger: "next session" / "we're done" / "end of session" / "סגור את הסשן") — do ALL of:
   - Update **Current feature inventory** with anything new.
   - Update `CURRENT_TASK.md → Next` and `Recommended next step`.
   - Update **Project structure** if files were added or changed.
   - **Never change `Your instruction`** — only the user changes that.
