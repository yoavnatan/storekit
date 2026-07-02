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
- **Stack:** Astro SSR + Node adapter, TypeScript throughout, Tailwind v4, Heebo font, `tokens.css` color system, static/SSR split (content pages = static, seller/admin/api = SSR). Header: `position: fixed; top:0; left:0; right:0` + `body { padding-top: 3.3rem }` — content bounces naturally, header stays fixed. Same height across all pages.
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
- **Auth:** Unified account system (seller + buyer same accounts). Register = name+email+password only (no forced store). Login/register/logout all preserve `?next=` and return user to origin page. Login/register pages use `sellerMode={true}` (clean header, no nav clutter). Dashboard shows "open first store" CTA when no stores exist (no redirect). **Google OAuth** — `/api/auth/google` (initiates; generates CSRF state + stores `oauth_next` cookie) → Google → `/api/auth/google/callback` (verifies state, exchanges code, fetches user info); merge logic: find by `googleId` → else find by email + link → else create new account; `Seller.googleId?: string`, `passwordHash` empty for OAuth-only accounts. Env vars required: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (optional `GOOGLE_REDIRECT_URI`). Login + register pages show "המשך עם Google" button with Google SVG above the email/password form.
- **Dashboard:** Multi-store tabs + store-switcher dropdown; AJAX product CRUD; sortable table (row #, thumbnail, stock warning icon); collapsible settings; store overview card; 8 script modules in `src/scripts/dashboard/`; no-store state shows "open your first store" banner (form → `create-store` action). **Header:** `dash-head__top` flex row holds store name + "צפה בחנות" button (space-between). **Settings form:** save button shows ✓ "נשמר" spring animation (same spring as product rows) on success. **Product row kebab menu** — ⋮ three-dot dropdown with eye icon + "צפה במוצר" (opens PQV modal; full-page product link opens in new tab via `newTab:true` on `pqv:open`), pencil icon + edit, trash icon + delete (`initProductMenus()` + `initViewProduct()`; ARIA `role="menu"`/`role="menuitem"`; keyboard nav + Escape). **Inline cell editing** — click name/price/stock cell → replaces with `<input>` → Enter or blur commits via `patch-product-fields` API action → Escape cancels; `committed` flag prevents double-submit (`activateInlineEdit()` + `initInlineEdit()` in products.ts). **Category chip** — each product row shows a small pill with its category (`data-category`); **category filter bar** above table (hidden until categories exist; chips rendered client-side; `refreshCategoryFilter()` called on add/delete). **Bulk actions bar** — bulk edit/upload/delete buttons are hidden in products-header until ≥1 product selected (`hidden` toggle, not `disabled`); count badge in title side (space-between layout prevents badge from shifting action buttons); select-all toggles all/none; bulk edit opens all selected inline edit rows simultaneously; bulk image upload auto-saves on gallery "סיים"; bulk delete with confirmation modal. **Product table** — 9 columns: checkbox | # | thumbnail (42px, `thumb-col`) | name | category (`cat-col`, sortable, hidden on mobile <600px) | price | stock | wishlist | actions; category chip moved from name cell to its own column; thumbnail skeleton shimmer (`thumb-wrap` + `img.decode()` timing fix); save button shows ✓ "נשמר" spring animation + auto-closes edit row after 1.5s; edit row header shows product thumbnail + name.
- **Images:** Cloudinary upload; BG removal Web Worker (`@imgly`, `isnet_quint8`, resize to 1024px); crop/zoom modal (OffscreenCanvas); up to 5 images per product (`images?: string[]`); gallery widget. **Optimization:** `passthroughImageService()` in `astro.config.mjs` (Cloudinary CDN handles transforms, no Sharp re-download); `cdnSrc(url, w?)` in `store.config.ts` adds `f_auto,q_auto,w_N`; `thumbUrl(url, w?, h?)` in `src/lib/cloudinary.ts` (server) and `src/scripts/dashboard/cloudinary.ts` (client) adds `w_N,h_N,c_fill,f_auto,q_auto` — used for all dashboard thumbnails (84×84 served, 42px displayed at 2× DPR); `<Image />` from `astro:assets` on all public pages; consistent widths per context (card=400, carousel=300, thumb=128, product-main=800) for shared browser cache across pages; first images `fetchpriority="high"`, rest lazy.
- **Store page `/store/[slug]`:** Product grid; **product detail modal** (click image/name → modal; `history.pushState` syncs URL to `/store/slug/product`; ESC/backdrop close; image gallery + lightbox-from-modal; qty + add-to-cart + wishlist; direct URL → SSR product page); lightbox (arrows/keyboard/swipe/touch); **header search** (always visible in fixed header on store + product pages; dropdown with 5 product cards + recent searches on focus; `?q=` URL param syncs to header input on load; X clears filter on store page or navigates to store on product page; no results = sort+category chips hidden); **filter + sort bar** — `display:flex;gap:0.5rem;flex-wrap:wrap` wrapper; category chips + sort button all share same `gap:0.5rem`; **category chip CSS** in `store.css` using `[aria-pressed="true"]` selector (no inline JS styles — CSS handles all states including hover/active); active+hover has explicit `color:#fff` to prevent cascade override; **sort button** — icon-only (3-line SVG + chevron, `border-radius:9999px`); `[aria-expanded="true"]` state: transparent border + omnidirectional shadow `0 0 0 1px rgba(0,0,0,0.06), 0 2px 12px rgba(0,0,0,0.11)`; `:focus` outline removed, `:focus-visible` kept; **sort menu** — `min-width:11rem;white-space:nowrap`, positioned `rtl:right-0`; selected option: `font-bold text-[var(--color-text)]` (black); no ripple on sort options; **URL sync** (`?q=`, `?category=`, `?sort=` restored on load); add to cart (spring animation + qty stepper); wishlist hearts; "New" badge; `dir="auto"` bidi; **light banner** (neutral surface, no strip); **banner actions** — fav + contact buttons in `.store-banner__actions` at bottom of banner (`.store-banner-action-btn` pill style: `border:0.75px solid var(--color-border); border-radius:9999px; background:none; font-size:0.78rem`; wrapper div has `display:flex;align-items:center` for equal height alignment; contact button kept only for non-owner buyers, uses id `contact-store-btn-banner` for JS); **product card image gap fix** — no `border-radius` on `.product-card__img-wrap` (parent `.card { overflow:hidden }` handles clipping); **skeleton shimmer** on product card images (`.is-loading` class removed on `load`/`error`, CSS `::before` pseudo-element with gradient sweep). **Product card image carousel** — horizontal `scroll-snap-type:x mandatory` per card; pagination dots overlaid at bottom of image (`position:absolute; bottom:7px`) inside `img-wrap`; glassmorphism pill (`rgba(255,255,255,0.15) + backdrop-filter:blur(8px) + border:0.75px solid rgba(255,255,255,0.2)`); white dots with `box-shadow:0 0 0 1px rgba(0,0,0,0.25)`; active dot = 18px, inactive = 6px; JS: `ResizeObserver` caches `slideW` (no `offsetWidth` in scroll handler); rAF-throttled scroll handler updates dot widths without `Math.round` (keeps pill size constant); `stopPropagation` on dots prevents modal open; touch handler disables snap on `touchstart`, snaps programmatically on `touchend` (8% threshold, overflow:hidden momentum kill); RTL-aware dot clicks + swipe; settle animation (80ms debounce → `width 220ms spring`). **Store header back-link:** arrow-only at rest; on hover "ShopNest" text fades+slides in (`max-width` + `opacity` + `margin-inline-start` transition). Backup pre-modal at `_backup/store-slug.astro`
- **Product page `/store/[storeSlug]/[productSlug]`:** Main image + thumbnail switcher; lightbox on image click; qty stepper; add to cart; wishlist; related products row ("עוד מ-", horizontal scroll, opens product modal + updates URL like store page); back-link (← "לחנות" / "To store"); BreadcrumbList JSON-LD + Product JSON-LD (`category` + `keywords` from tags); SEO meta; low-stock indicator; full-width details section (description, specs table RTL-aligned, **category chip** links back to filtered store, tags)
- **Categories & Tags:** Separate concepts — `category?: string` on each product (one per product, drives store filter chips); `tags?: string[]` for SEO/search/recommendations. Category in Product JSON-LD schema. Dashboard: category field with `<datalist>` suggestions from store settings; store settings still has `categories` field for datalist suggestions.
- **Cart:** Per-store localStorage (`store_cart_v2_{slug}`); CartDrawer (grouped by store, per-store subtotals, grand total, "Pay all stores"; clicking a cart item opens PQV modal via `pqv:open` event); qty ripple; confirm modal on remove; `syncCartImages()`. **Server-side persistence:** `data/user-carts.json` + `src/lib/user-carts.ts` + `/api/user-cart` (GET/POST). `src/lib/cart-sync.ts` (client module): merge guest→user on login (max qty per item, wishlist union), debounced save on every change (1.2s), load on return login. `BaseLayout` inline script tracks `__cu` (current user ID) in localStorage; detects login/logout/user-switch and sets `window.__pendingCartSync = 'merge'|'replace'|''`.
- **Wishlist:** localStorage + server-side sync (same `user-carts.json` / cart-sync module as cart above). WishlistDrawer (qty controls, two-step remove, cover images; skeleton on open with image preloading — `new Image()` per item before `render()`, 500ms max timeout; `loading="eager"` on all drawer images to avoid lazy-load flicker). Product page wishlist button: `visibility:hidden` SSR + `is:inline` script reads localStorage synchronously before first paint → no FOUC.
- **Homepage `/`:** No hero section — search bar lives in the sticky header (`showSearch={true}` prop on `BaseLayout`); greeting bar at top (logged-in only); active carts section (always visible — shows "אין עגלות פעילות כרגע" when empty, skeleton on first paint); **cart chips redesigned** — split `<div>` with `<a>` (store link, border-start-start-radius) + `<span>` separator + `<button>` (opens cart drawer, border-start-end-radius); icon circle gradient `#2a3c40→#3a5260` matches add-to-cart button; `align-self:stretch` on both halves for full-height hover area; ripple on both halves via `spawnRipple()`; hover `color-mix(in srgb, #2a3c40 8%, transparent)`; no count badge next to heading; per-store product carousels with scroll arrows (IntersectionObserver horizontal lazy-load via `data-lazy-src`; first 3 images of first store eager); carousel shadow fix: `padding-bottom:2.5rem; margin-bottom:-2rem`; carousel arrow buttons positioned at center of product image (calc-based, responsive); ripple on all homepage buttons; seller CTA banner (`isLoggedIn && !hasStore`)
- **Checkout `/checkout`:** SSR page — buyer fills name/email/phone/city/street; **email pre-filled from session** (`getSellerById` → `seller.email`); order summary rendered client-side from localStorage per store with shipping calc; form submits to `/api/checkout` POST; server re-validates all prices from JSON (never trusts client prices), calculates shipping per store from `store.shipping` config, creates order; **saves `buyerId`** (logged-in user's sellerId) on Order when user is authenticated. `/checkout/success` — `prerender=false`, `hideNav={true}`, clears localStorage cart + shows order number. `data/orders.json` + `src/lib/orders.ts` (Order interface + `buyerId?: string`, CRUD). `Store` interface now has `shipping?: { flatRate, freeAbove, processingDays }`. **Redesigned:** cart cards with product quick-view modal (PQV — native `<dialog>` with `showModal()`); lightbox inside PQV; product cache (`Map<string, PQVProduct>`); surgical qty patch (`patchQty()` — no full re-render on +/−, avoids card shadow flicker); stock enforcement on all qty steppers (checkout cards, CartDrawer, store page); `btn--accent` = CTA blue; `btn` base = dark teal-green gradient (`#2a3c40→#3a5260`) for add-to-cart; ripple excluded from qty buttons and `.pqv-trigger` card-name buttons. Auto-opens payment accordion when arriving via `?pay=1` (from PQV "לתשלום" button on non-checkout pages).
- **i18n:** `he`/`en` dictionaries; `getLang`/`getT`; lang cookie; language toggle in header; RTL-aware throughout. Header user-menu button uses `t.nav.userMenu` aria-label.
- **SEO / A11y:** `Seo.astro`, JSON-LD (Store/Product/Organization), sitemap; skip link, focus traps, ARIA roles, keyboard nav, aria-live regions
- **Ads architecture (tracking layer):** Single platform-owned GTM + Meta Pixel — fires on every page across all stores. `store.config.ts` has `ads: { googleTagId, metaPixelId }` (set once by platform admin). `BaseLayout` injects GTM head snippet + noscript iframe + Meta Pixel conditionally (IDs sanitized against injection). Data layer fires before GTM: `{ event:'page_view', page_type:'platform'|'store'|'product', store_id, store_name, store_slug, currency:'ILS' }`. Product pages add GA4 ecommerce: `{ ecommerce: { currency, items: [{ item_id, item_name, price, item_category }] } }`. Product OG: `og:type="product"`, `product:price:amount`, `product:price:currency`, `og:image={images[0]}`. Sellers never touch ad config — platform manages all campaigns centrally.
- **Tracking events — `src/lib/tracking.ts`:** `trackViewContent(item)` + `trackAddToCart(item, qty)` — push to `window.dataLayer` (GA4/GTM) AND call `window.fbq` (Meta Pixel) simultaneously. Fired on: product page load (ViewContent), add-to-cart from grid/modal/product page (AddToCart). Global Window types (`dataLayer`, `fbq`) declared in `src/env.d.ts`.
- **Messaging & Notifications:** `MessageCompose.astro` on store/product pages — buyer sends message to seller (POST `/api/messages`); no toast on success (status shown inline in modal); textarea `rows=6`; modal closes after 1.6s on success; form not stretched (`height:100%` removed — sizes to content). Seller sees "הודעות מקונים" tab in dashboard; buyer sees "הודעות ממוכרים" tab. Thread rows expand in-place (`loadThread(markRead)` always re-fetches live content on open, preventing stale SSR data). Live polling every 15s via `/api/messages?role=seller|buyer&unread=1` — adds per-row red dot + tab dot; refreshes open thread content live. URL sync: seller `?panel=messages`, buyer `?tab=messages` — SSR-based initial tab (no flash). Notifications stored in `data/notifications.json`; bell in Header polls every 30s; click routes to correct dashboard tab (new_order/order_update → `/seller/dashboard?panel=orders`); deleted on read (`deleteNotificationsByRelatedIds`). **Bell has X close button** — same design as wishlist X; `notif-close-btn` inside `.notif-panel-head` flex row. **Bell + wishlist + mobile-search mutual close** — opening any one closes the others (wishlist uses `wishlist:open` toggle event; mobile search's `closeOthers()` dispatches `wishlist:open` when wishlist is open — never sets `hidden` attribute on `#wishlist-panel` since WishlistDrawer uses `style.display`); no "mark all read" button in bell dropdown. Message threading: `replyToId?` on Message; `readBySeller`/`readByBuyer?` per message; `markThreadReadBySeller(originalId, sellerId)` marks original + all buyer replies; `markThreadReadByBuyer(originalId)` marks all. **Tab title badge** — `renderNotifs` in Header counts unread notifications; sets `document.title = "(N) originalTitle"` when N>0, restores to `originalTitle` when 0; `originalTitle` captured once at init before any polling.
- **Mobile header — store pages:** On ≤640px the search bar is hidden from the header and a magnifying-glass icon button (`#mobile-search-btn`, first in `header-actions`) opens a `position:fixed` panel (`#mobile-search-panel`) below it; the `#header-search` element is DOM-teleported into the panel slot on mobile and restored on desktop resize. Panel styled identically to notif/wishlist dropdowns. **Notifications + wishlist panels on mobile** — both `position:fixed; left:8px; right:8px; width:auto` at `rect.bottom+8` from their respective icon buttons (JS-positioned in `openNotifDrop()` + `WishlistDrawer.position()` for mobile ≤640px).
- **Orders — seller dashboard:** "הזמנות" tab in seller dashboard with accordion order cards (expand/collapse, buyer info, per-store items, tracking input, save button). **Filter bar** — "פעילות" (pending/processing/ready/shipped) / "הושלמו" (delivered) / "הכל"; default = פעילות; `data-shipping-status` attribute on each card; `applyOrderFilter()` runs on save + new card from poll. **Red dot** on pending orders; removed when status changes away from pending (+ deletes notification); re-added if status reverts to pending. **Live polling** every 15s via `/api/seller/orders?storeSlug=X`; new orders prepended + filter applied. `/api/seller/orders` — GET (auth-checked, returns orders for store) + PATCH (updates shippingStatus/trackingNumber/buyerDetails/itemDeletes/discount). Badge on tab button shows count of pending orders. **Custom status dropdown** — pill-shaped button (`border-radius:9999px`) showing current status (colored dot + label + chevron), opens to `position:absolute` menu matching design system (spring animation, `padding:0.3rem`, items `4px` radius); `overflow:visible` on `.order-card` and `#dash-main-card` to let menu escape. **Order edit modal** (`#edit-order-modal`, native `<dialog>`) — "ערוך פרטים" button on each card; sections: buyer details (name/phone/email/address), items (delete-only soft-delete with `.eom-item--deleted`), shipping method (placeholder card with disabled "שנה שיטת משלוח" btn for future), discount (% or ₪ toggle + live preview); PATCH recalculates subtotals + discount.applied on server. **Dashboard hover** — `#dash-main-card:hover { box-shadow:none }` (outer wrapper no hover), `.order-card:hover` keeps `0 2px 8px` shadow.
- **Orders — buyer dashboard:** "הזמנות" tab in buyer area — filtered by `o.buyerId === userId || o.buyerEmail === seller.email` (covers both linked and guest orders). Accordion cards with: order ID, date, items summary, payment/shipping badges, total in header; expanded body shows per-store product list with images + skeleton shimmer (`img.decode()` on open), store subtotal, tracking number if set. **Hover effect** on cards. **Thumbnail strip** — up to 3 product images (52×52, overlapping) in card header for at-a-glance preview.
- **ProductQuickView — image skeleton:** Main image renders with `data-src` (no src), `is-loading` on `.pqv-img-area` (shimmer animation); JS sets src + `img.decode()` → removes `is-loading`. `.pqv-img-area` has `aspect-ratio: 4/3` so container has height before image loads. Thumbnail switching also triggers skeleton.
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
data/messages.json              ← message threads (Message interface: id, fromUserId, toSellerId, replyToId?, readBySeller, readByBuyer?)
data/notifications.json         ← notifications (Notification: userId, type, relatedId?; deleted on read)
data/orders.json                ← orders store (flat array, keyed by id)
src/layouts/BaseLayout.astro    ← page shell (isLoggedIn, hasStore, storeMode, dataLayer, productPrice props; GTM+Pixel injection)
src/components/Seo.astro        ← all meta/OG/JSON-LD
src/components/Header.astro     ← nav (session-aware, storeMode-aware); notifications bell + polling every 30s
src/components/Footer.astro
src/components/CartDrawer.astro
src/components/WishlistDrawer.astro
src/components/ConfirmModal.astro ← global <dialog>, event-driven (confirm:open)
src/components/ProductQuickView.astro ← global PQV + lightbox dialogs; listens for pqv:open event (detail: {storeSlug, productSlug, storeName, newTab?}); `newTab:true` → product link gets `target="_blank"`; .pqv-trigger clicks; "לתשלום" opens accordion on checkout or navigates to /checkout?pay=1
src/components/MessageCompose.astro ← buyer contact form (store/product pages); dispatches toast with href to /buyer/dashboard?tab=messages
src/lib/cart.ts                 ← CartItem, localStorage cart, events, syncCartImages
src/lib/wishlist.ts             ← WishlistItem, localStorage wishlist
src/lib/wishlist-counts.ts      ← wishlist count badge sync
src/lib/ripple.ts               ← spawnRipple()
src/lib/seller-auth.ts          ← Seller interface (+ googleId?), register/login/session; getSellerByEmail/ByGoogleId, createGoogleSeller, linkGoogleAccount
src/lib/stores.ts               ← Store interface, CRUD (googleTagId?, metaPixelId?)
src/lib/store-products.ts       ← StoreProduct interface, CRUD (images?: string[])
src/lib/gallery-widget.ts       ← shared gallery HTML/escape helper
src/lib/tracking.ts             ← trackViewContent, trackAddToCart (dataLayer + fbq)
src/lib/user-carts.ts          ← UserCartData interface + getUserCart / saveUserCart (server adapter)
src/lib/cart-sync.ts           ← client module: merge guest→user cart on login, debounced save, load on return
src/lib/orders.ts              ← Order + OrderItem + StoreSubtotal interfaces; createOrder / getOrderById / updateOrder / getAllOrders
src/lib/messages.ts            ← Message interface + CRUD; markThreadReadBySeller / markThreadReadByBuyer; getMessageReplies (asc)
src/lib/notifications.ts       ← Notification interface; createNotification / getNotificationsForUser / deleteNotificationsByRelatedIds
src/env.d.ts                   ← global Window type augmentation (dataLayer, fbq, __sessionUserId, __pendingCartSync)
src/workers/bg-removal.ts       ← BG removal Web Worker (@imgly)
src/lib/cloudinary.ts           ← thumbUrl(src, w?, h?) — server-side Cloudinary URL transformer
src/scripts/dashboard/          ← bg-worker, cloudinary (upload + thumbUrl), status, crop-modal, gallery, products, ui
src/pages/index.astro           ← SSR homepage
src/pages/store/[slug].astro    ← SSR public store page (product modal experiment active)
src/pages/store/[storeSlug]/[productSlug].astro ← SSR product page (full UX: lightbox, related products, JSON-LD)
_backup/store-slug.astro        ← store page snapshot pre-modal (revert if needed)
src/pages/seller/               ← register, login, dashboard (SSR; ?panel=X URL sync; messages tab with live polling)
src/pages/buyer/dashboard.astro ← SSR buyer area; orders + messages (?tab=X URL sync; live polling every 15s) + profile
src/pages/checkout.astro        ← SSR checkout page (buyer details + address + client-side order summary)
src/pages/checkout/success.astro ← order confirmation page (clears cart, shows order ID)
src/pages/api/messages.ts      ← GET (list, repliesFor, unread=1); POST (send, reply, mark-read, mark-read-buyer, delete)
src/pages/api/notifications.ts ← GET (list + unread count); POST (mark-read, mark-all-read)
src/pages/api/                  ← product (actions: add-product, update-product, delete-product, bulk-delete-products, patch-product-fields), store, wishlist, lang, user-cart, checkout (POST → creates order)
src/pages/api/auth/google.ts   ← OAuth initiation: generates state cookie + redirects to Google
src/pages/api/auth/google/callback.ts ← OAuth callback: verifies state, exchanges code, fetches user info, find/create/link account, sets session
src/styles/main.css             ← single CSS entry point
src/styles/base/tokens.css      ← CSS variables (colors, spacing, radius)
src/styles/base/reset.css
src/styles/layout/container.css ← .container, .section
src/styles/components/          ← buttons, cards, forms, header, footer, cart-drawer, confirm-modal, product-card
src/styles/pages/               ← home, auth, dashboard, store, product, checkout
src/styles/utilities/utils.css  ← .muted, .badge, .visually-hidden, .skel-bar, @keyframes skeleton-shimmer; msg-thread, notif-dot styles
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
