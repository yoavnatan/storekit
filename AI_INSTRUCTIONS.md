# AI Instructions

Read this + `CURRENT_TASK.md` at session start.

---

## What we're building
Multi-vendor internet mall for the Israeli market. Sellers open stores; shoppers discover across them. Two independent SEO surfaces: platform (discovery) + each store (standalone feel).

**Mission:** Hebrew digital mall. No fixed fees; success-based only. Separate checkout per seller.

### Every seller gets out of the box
1. **Store** — product pages, SEO, platform discovery
2. **Shipping** — integrated Israeli carrier, per-store config, tracking
3. **Marketing** — GTM + Meta Pixel on every page; dataLayer feeds campaigns; seller picks budget only

### Israeli market — hard constraints
- **Payments:** Cardcom or Payme only. Never Stripe.
- **Shipping:** Sendit / Israel Post / iPost only.
- **Currency:** ILS (₪) always.
- **Language:** Hebrew-first, RTL.

### Payment architecture — decided
Platform holds one central Cardcom/Payme terminal. All payments go to platform.
- No per-seller payment account. Platform tracks `SellerBalance` (totalEarned − commission, totalPaidOut).
- Payouts: manual — admin marks paid. Commission % deducted at order creation.
- Admin dashboard: total revenue, per-seller balance, pending payout queue.

### Checkout — decided
Guest checkout only. Buyer: name, email, phone, address. No buyer registration/login/dashboard.

### Data models — canonical (add fields, never remove without discussion)
```
Order { id, buyerName, buyerEmail, buyerPhone, buyerAddress,
  items:[{productId,productName,storeSlug,storeName,price,qty,image}],
  shippingAmount, totalAmount, paymentRef, paymentStatus:'pending'|'paid'|'failed',
  shippingStatus:'pending'|'processing'|'shipped'|'delivered', trackingNumber?,
  createdAt, updatedAt, buyerId? }
SellerBalance { sellerId, storeId, totalEarned, totalPaidOut }
Store (add): shipping:{flatRate,freeAbove,processingDays}, contactEmail
StoreProduct (add): weight? (grams)
```

### Proactive obligations — always
- **dataLayer events** — page_view, view_item, add_to_cart, begin_checkout, purchase → `window.dataLayer` + `window.fbq`. Use `src/lib/tracking.ts`.
- **SEO** — every public page: unique title, description, JSON-LD, canonical via `BaseLayout → Seo.astro`.
- **Shipping** — always read from store settings, never hardcode.

---

## North star: physical mall model
| Physical | Platform |
|---|---|
| Entrance | `/` — discovery, search |
| Storefront | `/store/[slug]` |
| Cross-store | Natural recommendations, not aggressive |
| One bag | Unified cart, grouped by store |
| Cash register | Platform collects, tracks per-seller |
| Directory | Browse + category filters |
| Foot traffic | SEO drives store traffic |

Rules: (1) Each store is sovereign. (2) Platform chrome fades inside a store. (3) Discovery = serendipitous. (4) One bag, grouped by store. (5) Mall benefits when stores succeed.

---

## Core priorities
1. **SEO-first** — static pages, structured data, semantic HTML, fast load, no orphan pages.
2. **Automation-ready** — config-driven, clean serializable data.
3. **Simplicity** — no abstractions beyond task requirements.

## Architecture
- **Stack:** Astro SSR + Node adapter, TypeScript, Tailwind v4, Heebo font, `tokens.css` color system. Dev toolbar disabled (`devToolbar:{enabled:false}` in `astro.config.mjs`).
- **Split:** content pages = static, seller/admin/api = SSR
- **Header:** `position:fixed; top:0; left:0; right:0` + `body { padding-top:3.3rem }`. Never change to sticky.
- **Data:** `data/*.json` dev-only; pure DB adapter functions, swap-ready for SQLite/Postgres

---

## Hard rules
- **TypeScript everywhere** — no `.js` in `src/`, no `any`.
- **Tailwind v4 only** — no new CSS files or `<style>` blocks. Convert existing CSS on contact. Never name a custom CSS class the same as a Tailwind utility (e.g. `.grid`, `.flex`) — unlayered legacy CSS beats Tailwind's `@layer utilities` regardless of source order, silently breaking it (bit us: `.grid` in `container.css` was overriding `grid-cols-*`/`gap-*`; renamed to `.auto-grid`).
- **`<Image />` from `astro:assets`** for all platform images.
- **Colors via `tokens.css`** — never hardcode hex. Use `[color:var(--color-X)]`.
- **No emoji** — inline SVG icons (`aria-hidden="true"`, `currentColor`).
- **Lighthouse 100 target** — semantic HTML, proper alt/width/height, lazy loading.
- **Mobile-first** — 375px viewport, scale up with `sm:`/`md:`/`lg:`.
- **Modular** — UI = display only; DB/API/Cloudinary → `/src/services/` or `/pages/api/`. No file > 200 lines. SRP always.
- **Dropdown design system** — all dropdowns: `background:var(--color-surface)`, `padding:0.3rem` container, items `border-radius:4px` + `padding:0.45rem 0.75rem` + hover `var(--color-bg)`, spring `cubic-bezier(0.34,1.56,0.64,1) 0.13s`.
- **Micro-interactions** — `scale(0.97)` button `:active`; image `scale(1.06)` card hover; shadow growth; spring `cubic-bezier(0.34,1.56,0.64,1)`. 100–180ms hover, 220–320ms springs. No border-darkening. Every animation needs a reason.
- **Scalability** — stateless API routes; no shared write state. Ask: breaks at 1000 sellers + 10,000 buyers?
- **Inventory integrity** — atomic `decrementStock(productId,qty):Promise<boolean>`. JSON: async mutex (`src/lib/mutex.ts`). DB: `BEGIN TRANSACTION; UPDATE ... WHERE stock >= qty`. Payment webhooks: idempotency check on `paymentRef`.
- **Testing** — `tsc` after every change. Unit tests before money-touching code (`orders.ts`, `seller-balances.ts`, `decrementStock`, commission, shipping). Integration tests for `/api/checkout` + `/api/payment/confirm`. Playwright only for full E2E flows. Framework: Vitest.
- **Accessibility (WCAG 2.1 AA)** — skip link, focus traps on modals, Escape closes overlays, ARIA labels/roles/`aria-expanded`/`aria-live`, visible labels, 4.5:1 contrast, never color-only state.
- **SEO** — `BaseLayout → Seo.astro` always. JSON-LD Product on product pages, Store/LocalBusiness on store pages. Unique title+description per page.
- **i18n** — all strings via `getT(lang)`. Hebrew-first, RTL. Server-side `lang` conditionals for icon placement.
- **Ads** — sellers never touch ad config. One GTM + one Meta Pixel for whole platform. `dataLayer` provides `store_id`, `ecommerce.items`.
- File content in English. Chat in Hebrew.

---

## Features built
- **Auth:** Unified seller+buyer accounts. register=name+email+password, `?next=` on all flows. Google OAuth (`/api/auth/google` + callback): find by googleId → email+link → create. `Seller.googleId?`, empty `passwordHash` for OAuth. Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **Dashboard:** Multi-store tabs + switcher (alert dot on switcher btn + per-store in dropdown when pending orders or unread msgs); AJAX product CRUD; sortable table; inline cell editing (click name/price/stock → input → Enter commits, Escape cancels); category chip + filter bar; bulk actions (edit/upload/delete); kebab menu (view/edit/delete, PQV `newTab?`); store settings + save spring animation; sortable date-added column (hidden on mobile). 8 modules in `src/scripts/dashboard/`. Mobile: products table → CSS grid card layout (grid-template-areas: check/thumb/name/price/stock/actions; edit-row display:block).
- **Images:** Cloudinary upload; BG removal Web Worker (`@imgly` `segmentForeground`+`applySegmentationMask` — mask computed on a 1024px copy for speed, applied back onto the full-res original so quality isn't lost); crop output sized to the actual pixels selected (capped 2048, never a fixed size); manual cleanup modal (`cleanup-modal.ts`: erase/restore brush, independent zoom+pan — brush stays a fixed screen size so zooming in gives more precision, not a bigger brush); crop and bg-removal each keep a separate pristine snapshot + own undo so either can be redone after the other; saving a product resets+closes the image editor like a fresh reload (`finalizeGallery`/`closeGalleryPanel`). Up to 5 images/product. `passthroughImageService()`. `cdnSrc(url,w?)` → `f_auto,q_auto,w_N`. `thumbUrl(url,w?,h?)` → `c_fill,f_auto,q_auto` (server+client; thumb skeleton needs an ancestor of `.thumb-wrap` passed to `initThumbs`, never the wrap itself). Consistent widths: card=400, carousel=300, thumb=128, main=800.
- **Store page `/store/[slug]`:** Product grid; product modal (pushState URL sync); lightbox; header search (dropdown, recent searches, X clear, `?q=` sync); filter+sort bar (category chips `[aria-pressed]`, sort button with `[aria-expanded]` styling); product card image carousel (scroll-snap, dots, RTL, touch); store banner (fav+contact); skeleton shimmer. Back-link: arrow (14px) → hover reveals "ShopNest" text; house icon replaces `|` separator (mobile+desktop); store name truncates with ellipsis.
- **Product page `/store/[storeSlug]/[productSlug]`:** Image gallery + lightbox; qty stepper; add-to-cart; wishlist; related products row; BreadcrumbList+Product JSON-LD; SEO; specs table; category chip; tags. Grid `grid-cols-1 md:grid-cols-[minmax(0,440px)_1fr]` (image capped 440px). Mobile (<768px): image `aspect-ratio:4/3`; tight vertical gaps; qty+add-to-cart row (`#product-cta-row`) stays inline below the color picker AND mirrors into `#sticky-cart-bar` (fixed bottom, fades in via IntersectionObserver once the inline row scrolls away; own ids kept in sync via shared `qty`/`updateQty`; thumbnail deferred via `data-src`, only fetched on first reveal). Color-variant swatches: `border-radius:3px` (matches header badge, not circles).
- **Cart:** Per-store localStorage (`store_cart_v2_{slug}`). CartDrawer (grouped by store, PQV on item click). Server-side: `data/user-carts.json` + `/api/user-cart` + `src/lib/cart-sync.ts` (merge guest→user on login, debounced save 1.2s).
- **Wishlist:** localStorage + server sync. WishlistDrawer (skeleton, image preloading, no FOUC via inline script).
- **Homepage `/`:** Search in sticky header (store-search dropdown: finds stores by name/tagline, recent searches `home_search_recent_v1`, works on buyer dashboard too; data via `#home-search-stores-data` JSON embed; `<form role="search">` + empty `<datalist>` to block browser credential/history suggestions); greeting bar; active carts (split `<a>`+`<button>` chip); per-store carousels (IntersectionObserver lazy); seller CTA banner. Mobile: cart chips stack full-width (flex-direction:column, width:100%).
- **Checkout `/checkout`:** Guest+session; email pre-fill; client-side order summary + shipping calc; `/api/checkout` re-validates prices server-side, saves `buyerId`; PQV modal; `patchQty()` (no re-render on +/−); stock enforcement. `/checkout/success`: clears cart, shows order ID.
- **Orders — seller:** "הזמנות" tab; accordion cards; filter (active/completed/all); live poll 15s; status dropdown (pill); order edit modal (buyer details, item soft-delete, discount %/₪); red dot on pending; tab badge.
- **Orders — buyer / buyer dashboard:** Filtered by `buyerId || buyerEmail`; accordion with thumbnail strip; skeleton shimmer. Store name links to `/store/[slug]`. Header = `showSearch={true}` (homepage-style). Full i18n via `t.buyerDashboard.*`; JS strings via `#buyer-i18n` data attrs; date locale-aware.
- **Messaging:** `MessageCompose.astro` on store/product pages. Seller + buyer dashboard tabs. Thread expand in-place. Live poll 15s. URL sync (`?panel=messages` / `?tab=messages`). No SMTP — buyer sees seller email directly. Mobile: msg-table → grid card layout (grid-template-areas: status/from/date/actions/subject).
- **Notifications:** Bell polls 30s; routes to correct tab; deleted on read. X close button. Tab title badge `(N)`.
- **Mobile header:** ≤640px — store search + homepage search hidden → magnifying-glass opens fixed panel (DOM-teleport). Notif+wishlist panels: `position:fixed; left:8px; right:8px` at button rect. All dropdowns mutually close with fade-close animation (`.dropdown--closing`, opacity+scale 0.13s). Flash-on-resize fix: `visibility:hidden` on closed drawers + dropdown animations gated on `:not([hidden])` + `matchMedia` transition suppressor on buyer sidebar.
- **Cart/wishlist count badge:** `position:absolute` in `.cart-btn-wrap` wrapper (outside `<button>`), square with rounded corners at bottom-corner of icon — never expands button width. Pixel-precise centering: `line-height:1` + fixed px (no rem) + flexbox `align-items/justify-content:center`.
- **PQV (`ProductQuickView.astro`):** Native `<dialog>`; `pqv:open {storeSlug,productSlug,storeName,newTab?}`; lightbox inside. Main image = scroll-snap carousel + dots (mirrors `.product-card__slides/__dots`); thumbnails centered, same shimmer skeleton (`data-src` + `img.decode()`) as main image. "לתשלום" → checkout accordion or `/checkout?pay=1`. Store page's own product-click modal (`openProductModal` in `[slug].astro`, `.pm-*` classes) is a separate duplicate implementation — same carousel/dots/skeleton pattern applied there too.
- **Tracking:** `src/lib/tracking.ts` — `trackViewContent` + `trackAddToCart` → dataLayer + fbq. GTM+Pixel on every page. Product OG tags. Sellers never touch ad config.
- **Categories & Tags:** `category?:string` (one/product, filter chips) + `tags?:string[]` (SEO/search). Category in JSON-LD. Dashboard: `<datalist>` suggestions.
- **i18n:** `he`/`en` dictionaries; `getLang`/`getDir`/`getT`; lang cookie; RTL throughout. `buyerDashboard` section complete (all visible strings + JS strings via data attrs).
- **SEO/A11y:** `Seo.astro`, JSON-LD, sitemap, skip link, focus traps, ARIA, keyboard nav.

---

## Project structure
```
src/i18n/translations.ts        ← he + en string dictionaries
src/i18n/index.ts               ← getLang, getDir, getT
src/config/store.config.ts      ← platform config + formatPrice + cdnSrc
data/sellers.json               ← seller accounts
data/stores.json                ← store records
data/store-products.json        ← per-store products (storeId field)
data/user-carts.json            ← server-side cart + wishlist per user
data/messages.json              ← message threads
data/notifications.json         ← notifications (deleted on read)
data/orders.json                ← orders
src/layouts/BaseLayout.astro    ← page shell (GTM+Pixel injection)
src/components/Seo.astro        ← all meta/OG/JSON-LD
src/components/Header.astro     ← nav; notifications bell (polls 30s)
src/components/CartDrawer.astro
src/components/WishlistDrawer.astro
src/components/ConfirmModal.astro      ← global <dialog>, event-driven (confirm:open)
src/components/ProductQuickView.astro  ← global PQV + lightbox; pqv:open event
src/components/MessageCompose.astro    ← buyer contact form
src/lib/cart.ts                 ← CartItem, localStorage, events, syncCartImages
src/lib/wishlist.ts             ← WishlistItem, localStorage
src/lib/wishlist-counts.ts      ← count badge sync
src/lib/ripple.ts               ← spawnRipple()
src/lib/seller-auth.ts          ← Seller interface, register/login/session, Google OAuth
src/lib/stores.ts               ← Store interface + CRUD
src/lib/store-products.ts       ← StoreProduct interface + CRUD
src/lib/gallery-widget.ts       ← gallery HTML helper
src/lib/tracking.ts             ← trackViewContent, trackAddToCart
src/lib/user-carts.ts           ← getUserCart / saveUserCart
src/lib/cart-sync.ts            ← merge guest→user, debounced save
src/lib/orders.ts               ← Order interfaces + CRUD + buyerId
src/lib/messages.ts             ← Message interface + CRUD + markRead
src/lib/notifications.ts        ← Notification interface + CRUD
src/lib/cloudinary.ts           ← thumbUrl server-side
src/workers/bg-removal.ts       ← BG removal Web Worker (@imgly, mask-on-small + apply-to-full-res)
src/scripts/dashboard/          ← 8 modules: bg-worker, cleanup-modal, cloudinary, status, crop-modal, gallery, products, ui
src/pages/index.astro           ← SSR homepage
src/pages/store/[slug].astro    ← SSR store page
src/pages/store/[storeSlug]/[productSlug].astro ← SSR product page
src/pages/seller/               ← register, login, dashboard (?panel=X URL sync)
src/pages/buyer/dashboard.astro ← buyer area (?tab=X URL sync)
src/pages/checkout.astro        ← SSR checkout
src/pages/checkout/success.astro
src/pages/api/messages.ts       ← GET/POST messages
src/pages/api/notifications.ts  ← GET/POST notifications
src/pages/api/                  ← product, store, wishlist, lang, user-cart, checkout
src/pages/api/auth/google.ts    ← OAuth initiation
src/pages/api/auth/google/callback.ts ← OAuth callback
src/styles/main.css             ← single CSS entry point
src/styles/base/tokens.css      ← CSS variables
src/styles/base/reset.css
src/styles/layout/container.css
src/styles/components/          ← buttons, cards, forms, header, footer, cart-drawer, etc.
src/styles/pages/               ← home, auth, dashboard, store, product, checkout
src/styles/utilities/utils.css  ← .muted, .badge, skeleton-shimmer, msg-thread, notif-dot
src/env.d.ts                    ← global Window types (dataLayer, fbq, __sessionUserId, etc.)
_backup/store-slug.astro        ← store page pre-modal snapshot (revert if needed)
.claudeignore                   ← tells Claude to skip node_modules, dist, _backup, pics, fonts
```

---

## Workflow
1. Read this file + `CURRENT_TASK.md`.
2. Do only what is in `CURRENT_TASK.md → Your instruction`.
3. **End of session** (trigger: "next session" / "we're done" / "end of session" / "סגור את הסשן") — do ALL of:
   - Update **Features built**: merge new items into existing bullets (never add a bullet if the feature already exists). One line per feature max. No implementation details — names + key gotchas only.
   - Update **Project structure**: add new files, remove deleted ones. One line per file.
   - Update `CURRENT_TASK.md → Next` and `Recommended next step`.
   - Keep this file ≤ 200 lines total. If it grows, compress — merge bullets, drop details already in code.
   - **Never change `Your instruction`** — only the user changes that.
