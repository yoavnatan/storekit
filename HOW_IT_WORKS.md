# How it works — the site's behaviour, end to end

**What this is for.** The owner asked for it on 2026-08-23, after a session quoted him a line from
`GO_LIVE_CHECKLIST.md` that had stopped being true five days earlier and told him to run a cleanup
step that no longer exists: *"אני רוצה שיהיה לך סיפור שלם על איך האתר מתפקד, לא שתהיה מעודכן על משהו
שנכון ללפני שבוע"*.

The gap was structural, not careless. `AI_INSTRUCTIONS.md → Features built` is an INDEX — one bullet
per feature, grepped rather than read — and `GO_LIVE_CHECKLIST.md` is a list of what is MISSING.
Neither answers *"what happens, in order, when a seller registers or a buyer buys"*, so a session
assembles that answer from fragments and fills the gaps with what it assumes.

## The rule that keeps this file true

**It states the ORDER and the OWNER of each step, never the detail.** Order and ownership change
rarely; detail changes weekly, and a document that restates detail is a document that drifts — which
is the exact failure this file exists to answer. Every step names the module that owns it, and that
module's own header is where the reasoning lives. If you want to know *why* a step behaves as it
does, follow the name; do not expect the answer here, and do not copy the answer to here.

**Every step carries its state today**, and this is the half that rots fastest, so it is marked
rather than described:

- **✅ works** — a person can do this on a running server right now.
- **🔶 decided, unbuilt** — the decision is made and recorded; no code performs it yet.
- **⚠️ owner** — blocked on something only the owner can supply (`GO_LIVE_CHECKLIST.md → ⚠️ דורש אותך`).

**`tests/how-it-works.test.ts` checks the mechanical half** — that every module, npm script and
environment variable named below still exists. It cannot check whether a sentence is still true;
nothing can. So the standing rule is the one now beside the ⚠️ index: **change a behaviour, and grep
this file for it before you finish.**

---

## 1. A seller opens a shop

The shape of this flow is one decision (owner, 2026-08-23): **everything is buildable and visible;
only the moment something goes OUT is blocked.** The reasoning is in `lib/store-publication.ts` and
it is the platform's acquisition bet — *"מי שלא ראה מה הוא מקבל לא ישלם"*.

| # | What happens | Owner | Today |
|---|---|---|---|
| 1 | Registers with email+password or Google. No card is asked for, ever, at this step | `lib/seller-auth.ts` · `/seller/register` | ✅ |
| 2 | Creates a store — name, latin slug, basics. Up to `MAX_STORES_PER_SELLER` | `lib/stores.ts#createStore` | ✅ |
| 3 | Builds it: products, images, variants, categories, discounts, coupons, design. No cap on any of it | `lib/store-products.ts`, `lib/discounts.ts` | ✅ |
| 4 | Looks at it. The shop is `unpublished` — the public cannot reach it, the OWNER can | `lib/store-status.ts` · `store-publication.ts#mayPreviewStore` | ✅ |
| 5 | Chooses a plan. Four tiers, same product, differing only in fee-to-commission ratio. Changing it while already paying patches the PayMe subscription's price — never cancels it — and applies from the next charge | `lib/pricing.ts` · `lib/seller-tier.ts` · `lib/seller-subscription.ts` · `/pricing` | ✅ |
| 6 | Starts the monthly subscription — the seller's card charged by PayMe to OUR merchant account | `lib/seller-subscription.ts` | ⚠️ owner (needs live PayMe) |
| 7 | Gets a clearing account, which PayMe examine — up to 7 business days (agreement §11) | `lib/seller-merchant.ts` | ⚠️ owner |
| 8 | **The shop publishes itself.** Nobody presses a button — publication is the derived result of both holds clearing | `store-publication.ts#syncStorePublication` | ✅ |

**Two holds, one state, and that is deliberate.** A shop is held back by an unpaid subscription or
by unfinished clearing. The consequence is identical — he sees it, the public does not — so it is
ONE state with two sentences, never two booleans that can contradict each other. The seller is told
which hold applies and whether it is his to fix: `components/dashboard/PublishStatusCard.astro`.

**With no PayMe credentials configured at all, neither hold applies and shops publish normally.**
That is the dev and pre-launch state, and it is why a fresh server does not look empty.

`syncStorePublication` is called from every place a hold can lift — the dashboard, the PayMe
callback, and the `store-publication` job — because a seller who paid, closed the tab and never came
back must not be left dark.

---

## 2. A buyer buys

| # | What happens | Owner | Today |
|---|---|---|---|
| 1 | Finds a product: platform home, `/stores`, search, a store's own grid, or a store's custom domain | `lib/product-listing.ts`, `pages/search.astro` | ✅ |
| 2 | Opens it — full page, or the shared modal from a card (which pushStates the product's URL) | `pages/[storeSlug]/[productSlug].astro` · `components/StoreProductModal.astro` | ✅ |
| 3 | Adds to cart. Cart is per-store in `localStorage`, synced server-side for signed-in buyers | `lib/cart.ts` · `lib/user-carts.ts` | ✅ |
| 4 | Checks out as guest or signed in. Prices are **re-derived server-side**; the cart is never trusted | `/api/checkout` · `lib/discounts.ts` | ✅ |
| 5 | Pays — **authorize → write orders → capture**, in that order, so money and orders cannot exist without each other | `lib/payment.ts` · `lib/payment-split.ts` | 🔶 (mock provider in dev) |
| 6 | One card entry, one authorization, **one capture per store**; shipping is a separate capture to OUR account | `lib/payment-split.ts` | 🔶 |
| 7 | Order rows are written **one per store** — seller isolation — sharing a `checkoutRef` | `lib/orders.ts` | ✅ |
| 8 | Stock came off the shelf before the charge, in one statement, and goes back on any failure | `store-products.ts#decrementStock` | ✅ |
| 9 | Confirmation mail to the buyer, "new order" to each seller. Neither can fail the purchase | `lib/email/` · `lib/notifications.ts` | ✅ (mail is a stub, ⚠️ §4) |

**The order of steps 5–8 is the whole design and must not be rearranged.** No transaction spans a
payment gateway and a database, so the only way to have both is to make the first step reversible
and the irreversible one last. `lib/payment.ts`'s header carries the failure table.

**In production with the mock provider the server refuses to sell at all** (503, before the body is
even read) — `lib/site-mode.ts`. That refusal is DERIVED from what the provider is, so connecting a
real gateway opens the shop by itself. `ALLOW_MOCK_CHECKOUT=1` is the explicit bypass, and while it
is on anyone can order for free.

---

## 3. After the sale

| What happens | Owner | Today |
|---|---|---|
| Seller moves the order: `pending → processing → shipped → delivered`, with a tracking number | `lib/order-status-rules.ts` | ✅ |
| Buyer is notified on every change without the seller writing anything | `lib/notifications.ts` · `lib/notification-copy.ts` | ✅ |
| Seller cancels: stock returns and the debt to the buyer is recorded | `lib/refund-owed.ts` (`refund_due`) | ✅ |
| **The money actually going back** | — | 🔶 `refund_settled` is written by nothing |
| Buyer opens a return; statutory window; no cancellation fee, ever | `lib/returns.ts` · `/returns-policy` | ✅ |
| An order the seller never ships is warned at day 7 and cancelled at day 14 | `lib/order-sla.ts` + the `order-sla` job | ✅ |
| Buyer may review — the gate is a PURCHASE, never an account | `lib/review-eligibility.ts` | ✅ |
| Shipping labels, carrier pickup, return legs | — | 🔶 ⚠️ §5, courier not connected |

**The refund gap is the one place this flow tells a seller to do something whose second half does not
exist.** It is tracked in `GO_LIVE_CHECKLIST.md` §2.4.1 and is `CURRENT_TASK` סשן א׳ §2.

---

## 4. Money — who pays whom

**The platform never holds a shekel of a seller's money** (split model, 2026-08-21). PayMe capture
each store's share into that seller's own account as the charge happens and take our distribution
fee inside the same transaction.

| Flow | Direction | Owner | Today |
|---|---|---|---|
| Buyer → seller, per store | never through us | `lib/payment-split.ts` | 🔶 |
| Buyer → us, for shipping | our own merchant account | `lib/payment-split.ts` | 🔶 |
| Our commission | taken inside the sale, transferred monthly | `lib/pricing.ts#commissionOnAgorot` | 🔶 |
| Seller → us, monthly subscription | PayMe recurring on his card | `lib/seller-subscription.ts` | 🔶 |
| Advertising | billed on actual spend + a disclosed margin, **never offset** against the above | `lib/ad-metrics.ts` | 🔶 |
| The buyer's tax invoice | **the SELLER's**, not ours | `lib/invoicing/buyer-invoice.ts` | ✅ (records that he says he issued one) |

Every reported number is derived from orders, never stored as a total: `lib/order-totals.ts`,
`admin-stats.ts#orderNetForStore`, `lib/seller-balance.ts`. `lib/reconcile.ts` computes the same
figures a second way and is the tie-breaker against any code that disagrees with it.

---

## 5. Discovery — how anyone finds the place

| What | Owner | Today |
|---|---|---|
| Every store and product is a crawlable page with its own URL; Hebrew slugs are kept | `lib/url-base.ts#toSlug` | ✅ |
| The platform's own pages and every store/product are enumerated in `/sitemap-content.xml` | `lib/sitemap-document.ts` | ✅ |
| A store with no visible product is `noindex` and out of the sitemap — never a 404 | `lib/store-readiness.ts` | ✅ |
| **Showcase stores are `noindex` and sitemap-excluded**, though they appear on the home page and in `/stores` | `lib/demo-stores.ts` | ✅ |
| A product feed for Google/Meta, rebuilt by a job | `lib/product-feed.ts` + `feed-artifact` job | ✅ |
| Four funnel events to Google/Meta, all carrying the same catalog id | `lib/tracking.ts` · `lib/ad-item-id.ts` | ✅ (inert — tag ids empty, ⚠️ §2.2) |
| Baseline ads for every product, platform-funded; seller-funded Boost on top | `lib/ad-baseline.ts` · `lib/ad-campaigns.ts` | 🔶 no API connected |
| The whole site can be closed to crawlers with one switch | `SITE_NOINDEX=1` · `lib/site-mode.ts` | ✅ ⚠️ owner's judgement |

---

## 6. What runs with nobody watching

Sixteen jobs, one registry, claimed through the `job_runs` table so every instance can keep its
scheduler on: `lib/jobs/registry.ts`. **A job infers nothing** and never throws out of `run`.

The ones that change what a person sees: `store-publication` (publishes a shop whose holds lifted),
`order-sla` (gives a buyer's money back on a stalled order), `feed-sync` (pulls each store's external
inventory hourly), `review-invites`, `returns-sweep`, `inbox-digest`, `merchant-status`,
`custom-domain-check`. The rest are artifact rebuilds and retention purges.

---

## 7. The honest summary

**Works end to end today:** opening a shop, building a catalogue, browsing, cart, checkout against
the mock provider, orders, order status, notifications, returns intake, reviews, external inventory
sync, SEO surfaces, the seller and admin dashboards, and the help centre.

**Decided and unbuilt:** performing a refund, shipping labels and carrier pickup, boost campaigns
reaching a real ad API, Meta's Conversions API.

**Waiting on the owner:** ח.פ, a live domain and host, PayMe going live, the Google/Meta accounts and
their two tag ids, `ALERT_EMAIL`, an uptime monitor. All of it, with what each unblocks, is in
`GO_LIVE_CHECKLIST.md → ⚠️ דורש אותך` — that index is the authority, and this file only points at it.
