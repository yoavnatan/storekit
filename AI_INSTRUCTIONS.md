# AI Instructions

Read this + `CURRENT_TASK.md` at the start of every session. Nothing else unless the task requires it.

---

## What we're building
A **multi-vendor internet mall for the Israeli market** — sellers open their own stores, shoppers discover and move between them. Two independent SEO surfaces: the platform (discovery, cross-store links) and each store (its own title, description, JSON-LD, sitemap — feels like a standalone site).

**Vision:** Any Israeli independent business can open an online store easily — profitable, fair, fully transparent.
**Mission:** Hebrew-language digital mall. No fixed fees; success-based only. Each seller has a separate checkout.

### The product is a complete bundle — always build toward this
Every seller gets **three things** out of the box. Code decisions must serve all three:
1. **Store** — beautiful product pages, SEO, discovery on the platform
2. **Shipping** — integrated Israeli carrier (Sendit / Israel Post / iPost), shipping price config per store, tracking link for buyers
3. **Marketing** — GTM + Meta Pixel fire on every page automatically; dataLayer feeds Google/Meta campaigns; seller only picks budget + duration, never touches ad platforms

### Israeli market — hard constraints (non-negotiable)
- **Payments:** Israeli processors only — **Cardcom** or **Payme** as platform-level processor. Stripe is not available in Israel. Never hardcode Stripe anywhere.
- **Shipping:** Israeli carriers only — Sendit (aggregator, recommended first), Israel Post API, iPost. No FedEx/UPS/DHL as primary.
- **Currency:** ILS (₪) always. Already in config.
- **Language:** Hebrew-first, RTL. Already enforced.

### Payment architecture — decided, non-negotiable
**The platform holds one central Cardcom/Payme terminal. All buyer payments go to the platform.**
- No payment account per seller. Sellers need nothing to start selling.
- No automatic splitting at the payment processor level (avoids Israeli payment-facilitator regulation).
- Platform tracks each seller's earned balance in the DB (`SellerBalance`).
- Payouts to sellers are **manual** — admin transfers via bank/bit and marks as paid in the admin dashboard.
- Platform earns a commission % on every order (success-based). Commission deducted from seller balance, never charged separately.
- Admin dashboard must show: total revenue, per-seller balance (earned − paid out), pending payout queue.

### Checkout — decided, non-negotiable
**Guest checkout only.** No buyer account required.
- Buyer provides: full name, email, phone, shipping address.
- Order confirmation sent by email (to buyer + seller notification).
- No buyer registration, no buyer login, no buyer dashboard (for now).

### Data models — canonical shapes (add fields, never remove without discussion)
```
Order {
  id, buyerName, buyerEmail, buyerPhone, buyerAddress,
  items: [{ productId, productName, storeSlug, storeName, price, qty, image }],
  shippingAmount, totalAmount,
  paymentRef, paymentStatus: 'pending'|'paid'|'failed',
  shippingStatus: 'pending'|'processing'|'shipped'|'delivered',
  trackingNumber?,
  createdAt, updatedAt
}

SellerBalance {
  sellerId, storeId,
  totalEarned,   ← sum of (order items for this store) − commission
  totalPaidOut,  ← sum of manual payouts recorded
  // pending = totalEarned − totalPaidOut (computed, not stored)
}

Store (add to existing) {
  shipping: { flatRate: number, freeAbove: number | null, processingDays: number }
  contactEmail: string   ← seller notification email (may differ from login email)
}

StoreProduct (add to existing) {
  weight?: number   ← grams, for shipping quotes
}
```

### Proactive obligations — do these without being asked
These are part of every feature, not optional extras:
- **dataLayer events** — every significant user action (page view, view item, add to cart, begin checkout, purchase) must push to `window.dataLayer` AND call `window.fbq` if pixel loaded. Use `src/lib/tracking.ts`.
- **SEO** — every new public page gets unique title, description, JSON-LD, canonical via `BaseLayout → Seo.astro`. No exceptions.
- **Shipping config** — any checkout or order flow must read shipping cost from store settings, never hardcode.

---

## The Physical Mall Model — north star

Every product decision: **does this match how a real, physical mall works?**

| Physical mall | Platform |
|---|---|
| Entrance & corridors | `/` — discovery, trending, search |
| Store storefront | `/store/[slug]` — branding, products |
| Walking past, getting curious | Cross-store recommendations |
| One bag for all stores | Unified cart, items grouped by store |
| Each store's own cash register | One checkout, platform collects, tracks per-seller balance |
| Mall directory | Browse page, category filters |
| Mall reputation = trust | Platform brand gives legitimacy to small sellers |
| Foot traffic | SEO drives traffic to individual stores |
| Store pulls you in | Store page = immersion; customer feels "in" the store |

**Key rules:** (1) Each store is sovereign — independent business, not a template. (2) Mall is infrastructure, not the star — platform chrome fades inside a store. (3) Discovery is serendipitous — cross-store signals appear naturally, never as aggressive upsells. (4) One bag, grouped by store — customer always knows what came from where. (5) Checkout via Israeli payment processor — per-store first (default); platform handles routing behind the scenes. (6) Mall benefits when stores succeed — never extract value at buyers' or sellers' expense.

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
- **Dropdown design system** — all dropdowns share: `background: var(--color-surface)` (white), `padding: 0.3rem` container, items with `border-radius: 4px` + `padding: 0.45rem 0.75rem` + hover `var(--color-bg)`, spring animation `cubic-bezier(0.34,1.56,0.64,1) 0.13s`. Classes: `.user-dropdown` (header), `.store-switcher__menu` (dashboard), `.product-menu__dropdown` (dashboard kebab), sort `<ul>` (store page inline style).
- **Micro-interactions (non-negotiable)** — every interactive element must feel alive. Required: `scale(0.97)` on button `:active`; image `scale(1.06)` on card hover; shadow growth on hover; spring easing `cubic-bezier(0.34, 1.56, 0.64, 1)` for pop moments. Duration: 100–180ms hover, 220–320ms spring pops. No border-darkening — use shadow or background shift. Every animation needs a reason: feedback, affordance, or delight.
- **Scalability** — (1) stateless API routes (no module-level mutable vars, no in-process caches); (2) JSON = dev-only, pure swap-ready DB adapters; (3) no shared write state. Ask: breaks at 1000 sellers + 10,000 buyers?
- **Inventory integrity (race conditions — non-negotiable)** — stock decrement is NOT read→check→write. It must be atomic. Any checkout or reserve-stock path must call a single `decrementStock(productId, qty): Promise<boolean>` function that returns `false` if stock is insufficient — never trust a stock value read earlier in the same request. JSON adapter: use an in-process async mutex (`src/lib/mutex.ts`) to serialize all stock writes within a single Node process (acceptable for dev/single-instance). DB adapter: use `BEGIN TRANSACTION; UPDATE ... WHERE stock >= qty; COMMIT` — one round trip, no separate read. The mutex module must be a singleton (module-level `Map<string, Promise>`) — never instantiated per-request. Idempotency: payment webhooks must check for existing `paymentRef` before creating an Order — duplicate webhook calls must not create duplicate orders or double-decrement stock.
- **Testing — when to add (not optional at payment stage)** — `tsc` is always required after every change. Unit tests (`src/tests/`) are required before any code that touches money: `orders.ts`, `seller-balances.ts`, `decrementStock`, commission calculation, shipping calculation. Integration tests required for: `/api/checkout` (price re-validation, stock decrement, order creation), `/api/payment/confirm` (signature check, idempotency, balance update). Playwright only for full end-to-end flows (complete checkout, cart sync across pages) — never for CSS, text, or single-component logic. Test files mirror source: `src/tests/lib/orders.test.ts`, `src/tests/api/checkout.test.ts`. Framework: Vitest (already Vite-based via Astro — no extra bundler needed).
- **Accessibility (WCAG 2.1 AA)** — skip link in BaseLayout (`#main-content`); focus trap + restore on all modals/drawers; all interactive elements keyboard-reachable (Escape closes overlays); ARIA labels/roles/`aria-expanded`/`aria-live` throughout; every input has a visible label; SVG icons `aria-hidden`; no `div`/`span` as buttons; 4.5:1 contrast minimum; never communicate state by color alone.
- **SEO** — all public pages via `BaseLayout → Seo.astro` (never `<head>` directly). JSON-LD `Product` on product pages, `Store`/`LocalBusiness` on store pages. Unique `title` + `description` per page. All images: `alt`, `width`, `height`, `loading="lazy"`, `decoding="async"`.
- **i18n** — all UI strings via `getT(lang)`. Hebrew-first. RTL/LTR via `dir` on `<html>`. Use server-side `lang` conditionals for icon placement — Tailwind `ltr:/rtl:` variants unreliable.
- **Content from config** — all copy, nav, footer from data/config files, never hardcoded in components.
- **Ads — zero seller friction (non-negotiable)** — sellers never configure tracking pixels, GTM IDs, ad accounts, or anything ad-tech. The platform owns one GTM container and one Meta Pixel that fire on every page across all stores. The data layer provides rich context (`store_id`, `ecommerce.items`) so the platform can segment and target per-store campaigns from a single ad account. Any feature that requires a seller to touch an ad platform is wrong by design — redirect to a "promote my store" flow where the seller only chooses platform + budget + duration, and the platform handles everything via API.
- File content in English. Chat in Hebrew.

---

## Current feature inventory
- **Platform:** Astro SSR + Node, TypeScript, Tailwind v4, Heebo font, `tokens.css` palette, Cloudinary (whitelisted in astro.config)
- **Auth:** Unified account system (seller + buyer same accounts). Register = name+email+password only (no forced store). Login/register/logout all preserve `?next=` and return user to origin page. Login/register pages use `sellerMode={true}` (clean header, no nav clutter). Dashboard shows "open first store" CTA when no stores exist (no redirect). Google OAuth discussed, deferred.
- **Dashboard:** Multi-store tabs + store-switcher dropdown; AJAX product CRUD; sortable table (row #, stock warning icon); collapsible settings; store overview card; 8 script modules in `src/scripts/dashboard/`; no-store state shows "open your first store" banner (form → `create-store` action). **Product row kebab menu** — edit + delete moved into a ⋮ three-dot dropdown (`initProductMenus()` in products.ts; ARIA `role="menu"`/`role="menuitem"`; keyboard nav + Escape; closes on outside click).
- **Images:** Cloudinary upload; BG removal Web Worker (`@imgly`, `isnet_quint8`, resize to 1024px); crop/zoom modal (OffscreenCanvas); up to 5 images per product (`images?: string[]`); gallery widget. **Optimization:** `passthroughImageService()` in `astro.config.mjs` (Cloudinary CDN handles transforms, no Sharp re-download); `cdnSrc(url, w?)` in `store.config.ts` adds `f_auto,q_auto,w_N`; `<Image />` from `astro:assets` on all public pages; consistent widths per context (card=400, carousel=300, thumb=128, product-main=800) for shared browser cache across pages; first images `fetchpriority="high"`, rest lazy.
- **Store page `/store/[slug]`:** Product grid; **product detail modal** (click image/name → modal; `history.pushState` syncs URL to `/store/slug/product`; ESC/backdrop close; image gallery + lightbox-from-modal; qty + add-to-cart + wishlist; direct URL → SSR product page); lightbox (arrows/keyboard/swipe/touch); **header search** (always visible in sticky header on store + product pages; dropdown with 5 product cards + recent searches on focus; `?q=` URL param syncs to header input on load; X clears filter on store page or navigates to store on product page; no results = sort+category chips hidden); sort dropdown (body, right-aligned); **category filter chips**; **URL sync** (`?q=`, `?category=`, `?sort=` restored on load); add to cart (spring animation + qty stepper); wishlist hearts; "New" badge; `dir="auto"` bidi; **light banner** (neutral surface, no strip); **skeleton shimmer** on product card images (`.is-loading` class removed on `load`/`error`, CSS `::before` pseudo-element with gradient sweep). Backup pre-modal at `_backup/store-slug.astro`
- **Product page `/store/[storeSlug]/[productSlug]`:** Main image + thumbnail switcher; lightbox on image click; qty stepper; add to cart; wishlist; related products row ("עוד מ-", horizontal scroll, opens product modal + updates URL like store page); back-link (← "לחנות" / "To store"); BreadcrumbList JSON-LD + Product JSON-LD (`category` + `keywords` from tags); SEO meta; low-stock indicator; full-width details section (description, specs table RTL-aligned, **category chip** links back to filtered store, tags)
- **Categories & Tags:** Separate concepts — `category?: string` on each product (one per product, drives store filter chips); `tags?: string[]` for SEO/search/recommendations. Category in Product JSON-LD schema. Dashboard: category field with `<datalist>` suggestions from store settings; store settings still has `categories` field for datalist suggestions.
- **Cart:** Per-store localStorage (`store_cart_v2_{slug}`); CartDrawer (grouped by store, per-store subtotals, grand total, "Pay all stores"; clicking a cart item opens PQV modal via `pqv:open` event); qty ripple; confirm modal on remove; `syncCartImages()`. **Server-side persistence:** `data/user-carts.json` + `src/lib/user-carts.ts` + `/api/user-cart` (GET/POST). `src/lib/cart-sync.ts` (client module): merge guest→user on login (max qty per item, wishlist union), debounced save on every change (1.2s), load on return login. `BaseLayout` inline script tracks `__cu` (current user ID) in localStorage; detects login/logout/user-switch and sets `window.__pendingCartSync = 'merge'|'replace'|''`.
- **Wishlist:** localStorage + server-side sync (same `user-carts.json` / cart-sync module as cart above). WishlistDrawer (qty controls, two-step remove, cover images; skeleton on open with image preloading — `new Image()` per item before `render()`, 500ms max timeout; `loading="eager"` on all drawer images to avoid lazy-load flicker). Product page wishlist button: `visibility:hidden` SSR + `is:inline` script reads localStorage synchronously before first paint → no FOUC.
- **Homepage `/`:** Dark hero (`#07101e` + blue-teal radial glow `rgba(40,165,200,...)` centered, RTL/LTR-aware); content body lifts over hero with `border-radius: 2rem 2rem 0 0` + `margin-top: -2rem` (`.home-body`); search only; greeting bar below hero (logged-in only); per-store product carousels with scroll arrows (IntersectionObserver horizontal lazy-load via `data-lazy-src`; first 3 images of first store eager); carousel shadow fix: `padding-bottom:2.5rem; margin-bottom:-2rem` prevents Y-clipping from `overflow-x:auto`; carousel arrow buttons positioned at center of product image (calc-based, responsive); ripple on all homepage buttons (neutral gray, not accent-blue); active carts section (always visible — shows "אין עגלות פעילות כרגע" when empty, skeleton on first paint); seller CTA banner (visible only to logged-in users without a store — `isLoggedIn && !hasStore`)
- **Checkout `/checkout`:** SSR page — buyer fills name/email/phone/city/street; order summary rendered client-side from localStorage per store with shipping calc; form submits to `/api/checkout` POST; server re-validates all prices from JSON (never trusts client prices), calculates shipping per store from `store.shipping` config, creates order. `/checkout/success` clears localStorage cart + shows order number. `data/orders.json` + `src/lib/orders.ts` (Order interface, CRUD). `Store` interface now has `shipping?: { flatRate, freeAbove, processingDays }`. **Redesigned:** cart cards with product quick-view modal (PQV — native `<dialog>` with `showModal()`); lightbox inside PQV; product cache (`Map<string, PQVProduct>`); surgical qty patch (`patchQty()` — no full re-render on +/−, avoids card shadow flicker); stock enforcement on all qty steppers (checkout cards, CartDrawer, store page); `btn--accent` = CTA blue; `btn` base = dark teal-green gradient (`#2a3c40→#3a5260`) for add-to-cart; ripple excluded from qty buttons and `.pqv-trigger` card-name buttons. Auto-opens payment accordion when arriving via `?pay=1` (from PQV "לתשלום" button on non-checkout pages).
- **i18n:** `he`/`en` dictionaries; `getLang`/`getT`; lang cookie; language toggle in header; RTL-aware throughout. Header user-menu button uses `t.nav.userMenu` aria-label.
- **SEO / A11y:** `Seo.astro`, JSON-LD (Store/Product/Organization), sitemap; skip link, focus traps, ARIA roles, keyboard nav, aria-live regions
- **Ads architecture (tracking layer):** Single platform-owned GTM + Meta Pixel — fires on every page across all stores. `store.config.ts` has `ads: { googleTagId, metaPixelId }` (set once by platform admin). `BaseLayout` injects GTM head snippet + noscript iframe + Meta Pixel conditionally (IDs sanitized against injection). Data layer fires before GTM: `{ event:'page_view', page_type:'platform'|'store'|'product', store_id, store_name, store_slug, currency:'ILS' }`. Product pages add GA4 ecommerce: `{ ecommerce: { currency, items: [{ item_id, item_name, price, item_category }] } }`. Product OG: `og:type="product"`, `product:price:amount`, `product:price:currency`, `og:image={images[0]}`. Sellers never touch ad config — platform manages all campaigns centrally.
- **Tracking events — `src/lib/tracking.ts`:** `trackViewContent(item)` + `trackAddToCart(item, qty)` — push to `window.dataLayer` (GA4/GTM) AND call `window.fbq` (Meta Pixel) simultaneously. Fired on: product page load (ViewContent), add-to-cart from grid/modal/product page (AddToCart). Global Window types (`dataLayer`, `fbq`) declared in `src/env.d.ts`.
- **Israeli market:** Payments via Israeli processors only (Cardcom default, Tranzila, PayPlus — never Stripe). Shipping via Israeli carriers (Sendit aggregator, Israel Post, iPost). Currency ILS always. See "Israeli market — hard constraints" section above.

---

## Project structure
```
src/i18n/translations.ts        ← he + en string dictionaries (all UI namespaces)
src/i18n/index.ts               ← getLang, getDir, getT
src/config/store.config.ts      ← platform config + formatPrice + cdnSrc(url, w?)
data/sellers.json               ← seller accounts
data/stores.json                ← store records
data/store-products.json        ← per-store products (storeId field)
data/user-carts.json            ← server-side cart + wishlist per user (keyed by sellerId)
src/layouts/BaseLayout.astro    ← page shell (isLoggedIn, hasStore, storeMode, dataLayer, productPrice props; GTM+Pixel injection)
src/components/Seo.astro        ← all meta/OG/JSON-LD
src/components/Header.astro     ← nav (session-aware, storeMode-aware)
src/components/Footer.astro
src/components/CartDrawer.astro
src/components/WishlistDrawer.astro
src/components/ConfirmModal.astro ← global <dialog>, event-driven (confirm:open)
src/components/ProductQuickView.astro ← global PQV + lightbox dialogs (extracted from checkout); listens for pqv:open event + .pqv-trigger clicks; "לתשלום" opens accordion on checkout page or navigates to /checkout?pay=1 on other pages
src/lib/cart.ts                 ← CartItem, localStorage cart, events, syncCartImages
src/lib/wishlist.ts             ← WishlistItem, localStorage wishlist
src/lib/wishlist-counts.ts      ← wishlist count badge sync
src/lib/ripple.ts               ← spawnRipple()
src/lib/seller-auth.ts          ← Seller interface, register/login/session
src/lib/stores.ts               ← Store interface, CRUD (googleTagId?, metaPixelId?)
src/lib/store-products.ts       ← StoreProduct interface, CRUD (images?: string[])
src/lib/gallery-widget.ts       ← shared gallery HTML/escape helper
src/lib/tracking.ts             ← trackViewContent, trackAddToCart (dataLayer + fbq)
src/lib/user-carts.ts          ← UserCartData interface + getUserCart / saveUserCart (server adapter)
src/lib/cart-sync.ts           ← client module: merge guest→user cart on login, debounced save, load on return
src/lib/orders.ts              ← Order + OrderItem + StoreSubtotal interfaces; createOrder / getOrderById / updateOrder / getAllOrders
src/env.d.ts                   ← global Window type augmentation (dataLayer, fbq, __sessionUserId, __pendingCartSync)
src/workers/bg-removal.ts       ← BG removal Web Worker (@imgly)
src/scripts/dashboard/          ← bg-worker, cloudinary, status, crop-modal, gallery, products, ui
data/orders.json               ← orders store (flat array, keyed by id)
src/pages/index.astro           ← SSR homepage
src/pages/store/[slug].astro    ← SSR public store page (product modal experiment active)
src/pages/store/[storeSlug]/[productSlug].astro ← SSR product page (full UX: lightbox, related products, JSON-LD)
_backup/store-slug.astro        ← store page snapshot pre-modal (revert if needed)
src/pages/seller/               ← register, login, dashboard (SSR)
src/pages/checkout.astro        ← SSR checkout page (buyer details + address + client-side order summary)
src/pages/checkout/success.astro ← order confirmation page (clears cart, shows order ID)
src/pages/api/                  ← product, store, wishlist, lang, user-cart, checkout (POST → creates order)
src/styles/main.css             ← single CSS entry point
src/styles/base/tokens.css      ← CSS variables (colors, spacing, radius)
src/styles/base/reset.css
src/styles/layout/container.css ← .container, .section
src/styles/components/          ← buttons, cards, forms, header, footer, cart-drawer, confirm-modal, product-card
src/styles/pages/               ← home, auth, dashboard, store, product, checkout
src/styles/utilities/utils.css  ← .muted, .badge, .visually-hidden, .skel-bar, @keyframes skeleton-shimmer
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
