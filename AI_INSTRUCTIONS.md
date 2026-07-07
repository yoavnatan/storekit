# AI Instructions

Read this + `CURRENT_TASK.md` at session start.

---

## What we're building
Multi-vendor internet mall for the Israeli market. Sellers open stores; shoppers discover across them. Two independent SEO surfaces: platform (discovery) + each store (standalone feel).

**Mission:** Hebrew digital mall. No fixed fees; success-based only. Separate checkout per seller. **Sellers = registered businesses only** (עצמאים/עוסק פטור/מורשה, עסקים קטנים-בינוניים) — not private individuals; matches the split-payment provider's sub-merchant requirement (needs a registered business) and differentiates from Israeli P2P marketplaces (My Product, Yad2) which serve private sellers via manual escrow, not a branded storefront + shipping + marketing. **Fixed platform template only** — no per-seller site/theme design tooling, ever (deliberate scope boundary, not a gap to fill later). Not competing with Wix/Shopify on design freedom; target seller explicitly wants zero design decisions and speed, not a website builder.

### Every seller gets out of the box
1. **Store** — product pages, SEO, platform discovery
2. **Shipping** — integrated Israeli carrier, per-store config, tracking
3. **Marketing** — GTM + Meta Pixel on every page; dataLayer feeds campaigns; seller picks budget only

### Israeli market — hard constraints
- **Payments:** Split-payment via Israeli marketplace-capable processor — SUMIT or תקבול (Takbull), final pick pending (see "Payment architecture" below). Never Stripe.
- **Shipping:** Sendit / Israel Post / iPost only.
- **Currency:** ILS (₪) always.
- **Language:** Hebrew-first, RTL.

### Payment architecture — decided (revised 2026-07-06)
**Split payment via the payment processor.** Platform never holds seller funds — each seller has their own sub-merchant/business account with the processor; the processor splits the payment automatically at checkout: seller's share → seller, commission → platform. Reason: if the platform held seller money and disbursed it manually, that's a regulated financial/payment service in Israel (PSP license). Split payment avoids this — platform is a pure software/marketplace layer, sellers own product/fulfillment responsibility.
- Candidate providers (need direct confirmation of marketplace/split-payment support + terms): **SUMIT** and **תקבול (Takbull)** explicitly market a marketplace model (separate business account per seller). Cardcom/Payme/Tranzila/PayPlus/Meshulam are common Israeli gateways but their sub-merchant split support wasn't confirmed via search — contact them directly before committing.
- No manual payout queue — since the processor pays sellers directly, admin does **not** mark payouts as "paid". `SellerBalance`/admin dashboard becomes a **reporting** view (totalEarned per seller, for platform's own visibility), not a payout-management tool.
- Commission % still deducted at the processor/order level (`store.config.ts` → `checkout.commissionPercent`).

### Checkout — decided
Guest checkout only. Buyer: name, email, phone, address. No buyer registration/login/dashboard.

### Data models — canonical (add fields, never remove without discussion)
```
Order { id, buyerName, buyerEmail, buyerPhone, buyerAddress,
  items:[{productId,productName,storeSlug,storeName,price,qty,image}],
  shippingAmount, totalAmount, paymentRef, paymentStatus:'pending'|'paid'|'failed',
  shippingStatus:'pending'|'processing'|'shipped'|'delivered', trackingNumber?,
  createdAt, updatedAt, buyerId? }
SellerBalance { sellerId, storeId, totalEarned }  // reporting only — split payment means processor pays seller directly, no totalPaidOut/manual payout
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
- **Tailwind v4 only** — no new CSS files or `<style>` blocks. Convert existing CSS on contact. Never name a custom CSS class the same as a Tailwind utility (e.g. `.grid`, `.flex`) — unlayered legacy CSS beats Tailwind's `@layer utilities` regardless of source order, silently breaking it (bit us: `.grid` in `container.css` was overriding `grid-cols-*`/`gap-*`; renamed to `.auto-grid`). Also: a `@media` override doesn't gain specificity — a same-specificity unscoped rule *later in the file* silently wins regardless of viewport (bit us with `.dash-panel`/`.dash-tabs` mobile padding); qualify with an ancestor ID (e.g. `#dash-main-card .dash-panel`) instead of relying on source order.
- **`<Image />` from `astro:assets`** for all platform images.
- **Colors via `tokens.css`** — never hardcode hex. Use `[color:var(--color-X)]`.
- **No emoji** — inline SVG icons (`aria-hidden="true"`, `currentColor`).
- **Lighthouse 100 target** — semantic HTML, proper alt/width/height, lazy loading.
- **Mobile-first** — 375px viewport, scale up with `sm:`/`md:`/`lg:`.
- **Modular** — UI = display only; DB/API/Cloudinary → `/src/services/` or `/pages/api/`. No file > 200 lines. SRP always.
- **Dropdown design system** — all dropdowns: `background:var(--color-surface)`, `padding:0.3rem` container, items `border-radius:4px` + `padding:0.45rem 0.75rem` + hover `var(--color-bg)`, spring `cubic-bezier(0.34,1.56,0.64,1) 0.13s`.
- **Micro-interactions** — `scale(0.97)` button `:active`; image `scale(1.06)` card hover; shadow growth; spring `cubic-bezier(0.34,1.56,0.64,1)`. 100–180ms hover, 220–320ms springs. No border-darkening. Every animation needs a reason. `spawnRipple()` clips to its own dedicated inner layer, never to the target button directly (bit us: clipping the button itself silently swallowed any corner badge it carried — e.g. the avatar's alert dot — for as long as `overflow:hidden` stuck around).
- **"Tactile depth" design language** (piloted on the product page; rolled out to homepage, store page, buyer dashboard, checkout, cart drawer, PQV as of 2026-07-07) — **lone/hero surfaces** (single image wrap, detail card) get `border:1.5px solid var(--color-border)` + `box-shadow:var(--shadow-card)` → `--shadow-card-hover` on hover. **Secondary/repeated cards** (grid or list items — related-card, product-card, order-card) get the *lighter* `border:1px` + `--shadow-xs` → `--shadow-card-hover` on hover — using `shadow-card` at rest on a repeated card reads as heavy once multiplied across a grid (learned the hard way, see `src/styles/pages/product.css`'s `.related-card` for the correct reference, not the written rule alone). **Full-width list rows** (order card, table row — not a grid card) skip the shadow-hover entirely and use a `border-color` tint instead — `shadow-card-hover`'s blur/spread is calibrated for spaced-out grid cards and reads as excessive on a row stacked flush against its neighbors. Recessed controls (qty steppers, every instance site-wide) get `--shadow-inset`; pressed/active chips get `--shadow-xs`. No `translateY` hover-lift on a card whose image already has its own hover-zoom (double motion) — **exception:** the homepage's product cards keep `translateY(-5px)` deliberately, as a felt differentiator from an individual store's (flatter) product cards. Image containers that can hold a bg-removed (transparent) product photo must use `background:var(--color-surface)` (white), never `--color-bg` or `none` — plus a `border-bottom` separating the image from the card body when both are white. Tokens in `tokens.css`. Restrained on purpose — not neumorphism, not brutalist neon borders.
- **Scalability** — stateless API routes; no shared write state. Ask: breaks at 1000 sellers + 10,000 buyers?
- **Inventory integrity** — atomic `decrementStock(productId,qty):Promise<boolean>`. JSON: async mutex (`src/lib/mutex.ts`). DB: `BEGIN TRANSACTION; UPDATE ... WHERE stock >= qty`. Payment webhooks: idempotency check on `paymentRef`.
- **Testing** — `tsc` after every change. Unit tests before money-touching code (`orders.ts`, `seller-balances.ts`, `decrementStock`, commission, shipping). Integration tests for `/api/checkout` + `/api/payment/confirm`. Playwright only for full E2E flows. Framework: Vitest.
- **Accessibility (WCAG 2.1 AA)** — skip link, focus traps on modals, Escape closes overlays, ARIA labels/roles/`aria-expanded`/`aria-live`, visible labels, 4.5:1 contrast, never color-only state.
- **SEO** — `BaseLayout → Seo.astro` always. JSON-LD Product on product pages, Store/LocalBusiness on store pages. Unique title+description per page.
- **i18n** — all strings via `getT(lang)`. Hebrew-first, RTL. Server-side `lang` conditionals for icon placement.
- **Ads — two-tier model (decided 2026-07-06):** (1) **Baseline**, platform-funded — every product/store, by default, in a platform-wide feed powering Google Performance Max / Meta Advantage+ Catalog, paid from platform's own budget. Needs a bulk feed endpoint (Merchant Center + Meta Catalog) exporting all `StoreProduct`s — not built; today only per-page OG `product:price:*` tags exist (`Seo.astro`). (2) **Boost**, seller-funded — extra pay → more spend on their products; since catalog campaigns can't weight one product inside a shared campaign, a boost = a **separate dedicated campaign** per store/product (`adCampaigns`, via Google Ads/Meta Marketing API, billed through the split-payment provider). Either tier: sellers never touch targeting/creative, budget/duration only. One GTM + one Meta Pixel account for the whole platform (not per-seller) — what makes tier 1 possible with zero seller opt-in. `dataLayer` provides `store_id`, `ecommerce.items`.
- File content in English. Chat in Hebrew.

---

## Features built
- **Auth:** Unified seller+buyer accounts. register=name+email+password, `?next=` on all flows. Google OAuth (`/api/auth/google` + callback): find by googleId → email+link → create. `Seller.googleId?`, empty `passwordHash` for OAuth. Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **Dashboard:** Multi-store tabs + switcher (alert dot on switcher btn fires only when a store *other than* the currently-open one has a pending order/unread msg — points the seller TO the alert, not at what they're already looking at; per-store dot in dropdown for all stores incl. current; both update live via `updateSwitcherAlertDot()` as orders/messages get handled, no reload needed); AJAX product CRUD; sortable table; inline cell editing (click name/price/stock → input → Enter commits, Escape cancels); click a row's thumbnail or serial number also toggles its bulk-select checkbox; category chip + filter bar (active-chip hover no longer clobbers its text color); bulk actions (edit/upload/delete, select-all lives in the table's `.check-col` header on desktop with a synced mobile-toolbar twin — the table header itself is `display:none` in the mobile card layout, so that's the one reachable there); kebab menu (view/edit/delete, PQV `newTab?`); store settings + save spring animation; sortable date-added column (hidden on mobile); pagination (20/page); products toolbar + table header sticky under the site header on scroll (desktop; heights measured live via `ResizeObserver` so it stays pixel-flush) — both unstick themselves the moment a product's edit row is open (`:has()`), replaced by that row's own sticky header (thumb+name+Save/Cancel) so only one relevant thing stays pinned while editing; opening edit also smooth-scrolls the page so that header lands right under the site header, with a short `ResizeObserver` re-aim window afterward to correct for gallery images that finish loading late. Cancel restores the row's last-saved-state snapshot immediately (not just hide-and-leave-mutated) — any unsaved edit, including a still-blank variant dimension, is discarded right away instead of only becoming visible after a full page reload; snapshot is refreshed after every successful save. 8 modules in `src/scripts/dashboard/`. Mobile: products table → CSS grid card layout (grid-template-areas: check/thumb/name/price/stock/actions; edit-row display:block); checkbox/thumbnail pulled flush to the row edge; selecting products collapses bulk-action buttons to icon-only (horizontal-scroll fallback if still too tight) and shows the count as compact `(N)` instead of a text badge.
- **Images:** Cloudinary upload; BG removal Web Worker (`@imgly` `segmentForeground`+`applySegmentationMask` — mask computed on a 1024px copy for speed, applied back onto the full-res original so quality isn't lost); crop output sized to the actual pixels selected (capped 2048, never a fixed size); manual cleanup modal (`cleanup-modal.ts`: erase/restore brush, independent zoom+pan — brush stays a fixed screen size so zooming in gives more precision, not a bigger brush); crop and bg-removal each keep a separate pristine snapshot + own undo so either can be redone after the other; saving a product resets+closes the image editor like a fresh reload (`finalizeGallery`/`closeGalleryPanel`). Up to 5 images/product. `passthroughImageService()`. `cdnSrc(url,w?)` → `f_auto,q_auto,w_N`. `thumbUrl(url,w?,h?)` → `c_fill,f_auto,q_auto` (server+client; thumb skeleton needs an ancestor of `.thumb-wrap` passed to `initThumbs`, never the wrap itself). Consistent widths: card=400, carousel=300, thumb=128, main=800.
- **Store page `/store/[slug]`:** Product grid; product modal (pushState URL sync); lightbox; header search (dropdown, recent searches, X clear, `?q=` sync); filter+sort bar (category chips `[aria-pressed]`, sort button with `[aria-expanded]` styling); product card image carousel (scroll-snap, dots, RTL, touch); store banner (fav+contact); skeleton shimmer. Back-link: arrow (14px) → hover reveals "ShopNest" text; house icon replaces `|` separator (mobile+desktop); store name truncates with ellipsis. Tactile-depth pass: product cards + active category chip on tokens (see Hard rules), no hover-lift (homepage differentiator); removed a redundant darken-on-hover overlay that used to stack on top of the card's own shadow; image containers use `--color-surface` (not `--color-bg`) + a `border-bottom` separator so bg-removed product photos don't pick up a gray tint or merge into the card; card qty-stepper (direct add-to-cart on the grid) + modal qty-stepper both get `--shadow-inset`, add-to-cart button height pinned to match the qty-stepper exactly.
- **Product page `/store/[storeSlug]/[productSlug]`:** Image gallery + lightbox; qty stepper; add-to-cart (`#add-to-cart-btn` is `flex-auto` — fills the CTA row on every screen size, reveals `#to-checkout-btn` ("לתשלום", links to `/checkout`) next to it on click and shrinks to make room, same reveal pattern as the store page's `.pm-add-to-cart`/`.pm-to-checkout`); wishlist; related products row; BreadcrumbList+Product JSON-LD; SEO; specs table; category chip; tags. Grid `grid-cols-1 md:grid-cols-[minmax(0,440px)_1fr]` (image capped 440px). Out-of-stock variant option buttons are disabled, not hidden (dimmed + strikethrough) — computed server-side for the default selection, recomputed client-side per click against the buyer's current picks for every other dimension. Mobile (<768px): image `aspect-ratio:4/3`; tight vertical gaps; qty+add-to-cart row (`#product-cta-row`) stays inline below the color picker AND mirrors into `#sticky-cart-bar` (fixed bottom, fades in via IntersectionObserver once the inline row scrolls away; own ids kept in sync via shared `qty`/`updateQty`; no qty stepper of its own — image+name+price+add-to-cart only, so it covers less of the description; `#sticky-add-to-cart-btn` reveals its own `#sticky-to-checkout-btn` the same way; thumbnail deferred via `data-src`, only fetched on first reveal). Color-variant swatches: `border-radius:3px` (matches header badge, not circles). Tactile-depth pass (see Hard rules): image wrap/detail-card/related-cards get shadow-token border+shadow; qty stepper gets an inset shadow. Sticky footer: appears once `#add-to-cart-btn` itself is off-screen (even pre-scroll, if it starts below the fold); shows buttons-only+centered while the real image/name are still visible, mini image+name join in via an elegant flex-basis+opacity collapse (no dead gap) only once those scroll away too; inline+sticky `toCheckoutBtn`s always stay in sync regardless of which add-to-cart button was clicked. Thumbnail swap reveals on the new image's `load`/`error`, not a fixed timer (which could flash the old image back); points at the same `cdnSrc(...,800)` as the main image (was wrongly using the raw original) + idle-time prefetch of the rest of the gallery. Title enlarged slightly, price shrunk below it for a calmer price/title hierarchy.
- **Cart & Wishlist:** Cart: per-store localStorage (`store_cart_v2_{slug}`), CartDrawer (grouped by store, PQV on item click), server-side `data/user-carts.json`+`/api/user-cart`+`src/lib/cart-sync.ts` (merge guest→user on login, debounced save 1.2s). Wishlist: localStorage+server sync, WishlistDrawer (skeleton, image preloading, no FOUC via inline script). Cart-line qty-stepper gets `--shadow-inset` (tactile depth) + explicit `dir="ltr"` (was missing it — RTL mirrored +/- vs. every other qty-stepper on the site).
- **Homepage `/`:** Search in sticky header (store-search dropdown: finds stores by name/tagline, recent searches `home_search_recent_v1`, works on buyer dashboard too; data via `#home-search-stores-data` JSON embed; `<form role="search">` + empty `<datalist>` to block browser credential/history suggestions); greeting bar; active carts (split `<a>`+`<button>` chip); per-store carousels (IntersectionObserver lazy); seller CTA banner. Mobile: cart chips stack full-width (flex-direction:column, width:100%).
- **Checkout `/checkout`:** Guest+session; email pre-fill; client-side order summary + shipping calc; `/api/checkout` re-validates prices server-side, saves `buyerId`; PQV modal; `patchQty()` (no re-render on +/−); stock enforcement; qty-stepper gets `--shadow-inset` + same `dir="ltr"` fix as the cart drawer. `/checkout/success`: clears cart, shows order ID.
- **Orders — seller:** "הזמנות" tab; accordion cards; filter (active/completed/all); live poll 15s; status dropdown (pill); order edit modal (buyer details, item soft-delete, discount %/₪); red dot on pending; tab badge.
- **Orders — buyer / buyer dashboard:** Filtered by `buyerId || buyerEmail`; accordion with thumbnail strip; skeleton shimmer. Store name links to `/store/[slug]`. Header = `showSearch={true}` (homepage-style). Full i18n via `t.buyerDashboard.*`; JS strings via `#buyer-i18n` data attrs; date locale-aware. Tactile-depth pass: replaced an old ad-hoc shadow+ring hack (`0 1px 4px rgba(0,0,0,.07), 0 0 0 1px var(--color-border)`) with `border:1px` + `--shadow-xs` tokens on profile card/nav/order-card/message-card; order-card hover uses a border-color tint, not a shadow-lift (too heavy on a full-width stacked row, see Hard rules); order thumbnails use `--color-surface`. Seller dashboard (`dashboard.css`) still has ~9 of the same un-converted shadow-hack declarations — do that page next if continuing the tactile-depth rollout.
- **Messaging:** `MessageCompose.astro` on store/product pages. Seller + buyer dashboard tabs. Thread expand in-place. Live poll 15s (+ immediate poll on load, not just after the first interval tick). URL sync (`?panel=messages` / `?tab=messages`). No SMTP — buyer sees seller email directly. Mobile: msg-table → grid card layout (grid-template-areas: status/from/date/actions/subject/preview). Unread detection (tab dot, alert dots) checks reply messages too, not just the thread root — a reply carries no `toStoreId` of its own, only `toSellerId`, so it's checked via `getMessageReplies(rootId)` per thread (bit us: a buyer follow-up in an already-read thread wasn't flagging anything until the next poll). Mobile cards show a live last-message preview (`(את/ה)`/`(You)` tag when self-sent) + last-message date, kept in sync on poll without opening the thread (`refreshRowPreview`, shared helper). Unread accent = a straight `::before` bar, not a `border` (a border bends with the card's `border-radius`); buyer's per-row red dot removed in favor of bold text + a plain muted unread count (matches order-count style, no red pill; seller keeps its dot). Opening a thread scrolls the reply box (textarea+buttons) into view and focuses the textarea (`preventScroll`); a close-conversation button next to Send collapses it back with a subtle (`block:'nearest'`) scroll. Reply textarea focus border uses `--color-text`, not accent blue.
- **Notifications:** Bell shows a numeric unread-count badge (red, same `.cart-count` shape as cart/wishlist — not a plain dot); polls 30s + immediate refetch on `visibilitychange` (background-tab timers get throttled by the browser, this closes the gap the moment the tab regains focus); routes to correct tab; deleted on read. X close button. Tab title badge `(N)`. Seller alert dot (avatar + "sellers dashboard" dropdown link, header-wide via `/api/seller/alerts` + `src/lib/seller-alerts.ts`): persistent live indicator for pending orders/unread messages across all of a seller's stores — derived from real state each poll, so it can't go stale like a one-shot notification would if an order gets flipped back to "pending".
- **Mobile header:** ≤640px — store search + homepage search hidden → magnifying-glass opens fixed panel (DOM-teleport). Notif+wishlist panels: `position:fixed; left:8px; right:8px` at button rect. All dropdowns mutually close with fade-close animation (`.dropdown--closing`, opacity+scale 0.13s). Flash-on-resize fix: `visibility:hidden` on closed drawers + dropdown animations gated on `:not([hidden])` + `matchMedia` transition suppressor on buyer sidebar.
- **Cart/wishlist count badge:** `position:absolute` in `.cart-btn-wrap` wrapper (outside `<button>`), square with rounded corners at bottom-corner of icon — never expands button width. Pixel-precise centering: `line-height:1` + fixed px (no rem) + flexbox `align-items/justify-content:center`.
- **PQV (`ProductQuickView.astro`):** Native `<dialog>`; `pqv:open {storeSlug,productSlug,storeName,newTab?}`; lightbox inside. Main image = scroll-snap carousel + dots only (thumbnail strip removed 2026-07-07 as redundant with the carousel) — mirrored in the store page's own duplicate modal (`openProductModal` in `[slug].astro`, `.pm-*` classes). Both split into a scrollable body + a separate pinned CTA footer (qty/add-to-cart/wishlist/link always reachable regardless of content length; tried also freezing the modal's overall height so "show more" wouldn't resize it — reverted, kept causing gap/spacing bugs, modal just hugs its content naturally again). Description uses `src/lib/read-more.ts` (shared, char-based binary-search truncation so real newlines survive expansion) — 2-line clamp in both modals, 4-line on the full product page; "עוד" sits inline right after the ellipsis, "פחות" gets its own line. Variant option buttons: a selected non-color (text) option gets border+bold only, never a solid fill (color swatches keep their light tint) — same fix in all three variant-picker instances (PQV, store modal, product-page's related-items mini-modal). Name→price→desc→variants spacing unified to ~8px steps in both modals (was an inconsistent 6/14/16px jump). "לתשלום" → checkout accordion or `/checkout?pay=1`. PQV qty-stepper: shared SVG minus/plus icons + continuous border (was plain text glyphs with an extra divider, inconsistent with the rest of the site) + `--shadow-inset`; main-image area `--color-surface`.
- **Tracking:** `src/lib/tracking.ts` — `trackViewContent` + `trackAddToCart` → dataLayer + fbq. GTM+Pixel on every page. Product OG tags. Sellers never touch ad config.
- **Categories & Tags:** `category?:string` (one/product, filter chips) + `tags?:string[]` (SEO/search). Category in JSON-LD. Dashboard: category field narrower (`field--narrow`) with `<datalist>` suggestions; tags field wider (`field--tags`) and added as chips via the same collapsed-trigger→input→Enter pattern as variant values (hidden hoisted-comma input keeps `parseTags` server-side unchanged) — × arms a shared inline delete-confirm (`initRemoveConfirm()`, also resolves variant dim/chip removal; must be registered before the editors that arm it, or the outside-click-cancel check races the arm on the same click).
- **Variants & inventory (dashboard, inline in product edit — not a separate tab, deliberate):** `StoreProduct.variants?:{name,options:string[]}[]` (seller-defined dimensions, e.g. Color/Size/anything) + `variantStock?:Record<comboKey,number>` (optional per-combo stock; `src/lib/variant-combo.ts` → `comboKey()`/`generateCombos()`, shared by dashboard + storefront). Dashboard combo grid: one sortable + filterable column per dimension (filter = funnel dropdown, multi-select, AND across columns) + sticky Stock column (sticky both axes) + sticky Total row whose label always states what it's summing ("All" or the active filter values). Top-level "מלאי" field becomes read-only/auto-summed the instant variants exist (no more editable-independently-of-the-breakdown confusion); legacy products without `variantStock` yet get rows seeded via even-split of the current total (never silently changes the saved sum). Products-table stock column gets a read-only per-variant breakdown dropdown (quick glance, no need to open edit). Color recognition (`src/lib/color-variants.ts`) matches singular+plural He/En names; an unrecognized color gets an inline native color-picker chip stored as `"name #hex"` — always route through `resolveVariantColor()` before display or the hex leaks into labels. A variant type name can't duplicate another, synonym-aware (`canonicalDimName()` in `variant-combo.ts` — e.g. "צבע"/"צבעים" or "מידה"/"מידות" count as the same type, reusing `color-variants.ts`'s `COLOR_VARIANT_NAME_GROUP`): flagged live (red border) and reinforced at save (client `readVariantDims` + server `parseVariantsPayload` both dedupe); a still-unnamed dimension blocks adding values under it (would otherwise silently vanish on save since both layers require a name). Storefront product page: per-combo stock gates add-to-cart max-qty + low/out-of-stock text for the selected combo (falls back to total `stock` when unset), and disables (dimmed+strikethrough, not hidden) the specific out-of-stock option button itself; checkout-time atomic enforcement still not built (see `Next → לאחר מכן`). Gotchas: filter dropdowns render in one shared `document.body` portal (position:fixed, repositioned via `getBoundingClientRect()` on open) since a dropdown nested in the grid gets clipped by its own `overflow:auto` — any handler for portal content must skip the usual "no `.variants-editor` ancestor → return" guard; the mobile `.products-table tr.edit-row td{display:block}` rule is a descendant selector that also flattens this nested real `<table>`, needed a higher-specificity revert scoped to `.variant-combos`; `position:sticky` + `border-collapse:collapse` detaches borders, this table uses `separate`.
- **i18n:** `he`/`en` dictionaries; `getLang`/`getDir`/`getT`; lang cookie; RTL throughout. `buyerDashboard` section complete (all visible strings + JS strings via data attrs). **SEO/A11y:** `Seo.astro`, JSON-LD, sitemap, skip link, focus traps, ARIA, keyboard nav.

---

## Project structure
```
src/i18n/translations.ts + index.ts ← he+en string dictionaries; getLang/getDir/getT
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
src/lib/read-more.ts            ← initReadMore() (inline read-more/less)
src/lib/seller-auth.ts          ← Seller interface, register/login/session, Google OAuth
src/lib/stores.ts               ← Store interface + CRUD
src/lib/store-products.ts       ← StoreProduct interface + CRUD
src/lib/variant-combo.ts        ← comboKey()/generateCombos()/canonicalDimName() — shared by dashboard variant editor + storefront combo-stock lookups
src/lib/color-variants.ts       ← resolveVariantColor()/isColorVariant(); exports COLOR_VARIANT_NAME_GROUP (reused by variant-combo.ts's canonicalDimName)
src/lib/gallery-widget.ts       ← gallery HTML helper
src/lib/tracking.ts             ← trackViewContent, trackAddToCart
src/lib/user-carts.ts           ← getUserCart / saveUserCart
src/lib/cart-sync.ts            ← merge guest→user, debounced save
src/lib/orders.ts               ← Order interfaces + CRUD + buyerId
src/lib/messages.ts             ← Message interface + CRUD + markRead
src/lib/seller-alerts.ts        ← getSellerStoreAlerts/sellerHasAnyAlert (pending orders + unread msgs incl. replies)
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
src/pages/api/seller/alerts.ts  ← GET {hasAlert} for header avatar dot
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
