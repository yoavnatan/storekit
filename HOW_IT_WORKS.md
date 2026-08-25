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

### The funnel, on one picture

Asked for on 2026-08-24 — *"ליצור סדר מופתי עם תרשים מסודר של מה קורה איפה ומתי במשפך לקוח"* — after
several sessions on clearing and on plans had left the answer spread across five modules and three
screens. **The same nine stages are counted in the admin's נתונים tab** (`lib/seller-funnel.ts` →
`AdminDataPanel.astro`), so the picture below and the bars there are the same funnel: this says what
happens, that says how many people it happened to.

```
  VISITOR                     free — no card is ever asked for here
    │
    │  /pricing ─── compares four plans, sees what a plan covers ──┐
    ▼                                                              │
  ① registers ······················ /seller/register              │
    ▼                                                              │
  ② opens a shop ··················· up to 5 per account           │
    ▼                                                              │
  ③ builds it ······················ products · images · design    │
    │                                 categories · discounts       │
    ▼                                                              │
  ④ PREVIEWS it ···················· only he can reach it          │
    │                                 (state: unpublished)         │
    ═══════════════════════════════════ the line where he COMMITS ════
    ▼                                                              │
  ⑤ sends clearing details ········· his, minutes                  │
    ▼                                                              │
  ⑥ picks a plan, saves a card ····· his, one click ◄──────────────┘
    │                                 NOTHING IS CHARGED HERE
    ▼
  ⑦ PayMe examine the business ····· NOBODY's, up to 7 business days
    │                                 nothing to press; we email him
    ═══════════════════════════════════ the line where money MOVES ═══
    ▼
  ⑧ THE SHOP PUBLISHES ITSELF ······ the card is charged, the shop
    │                                 goes up, he is notified — and
    │                                 he pressed nothing to make it
    ▼
  ⑨ first sale
```

**The two lines across that diagram are the whole design, and they moved twice in one day.**

Paying used to be step ⑤ — before the review — so a seller paid and then sat up to seven business
days with a shop that was not on the site, through the week he is most likely to change his mind in
(*"אני לא רוצה ליפול בין הכיסאות ושהמוכר יתחרט"*). Moving it to LAST fixed that and opened the
opposite hole, which the owner named the same day: *"אם מוכר ממתין לאישור מפיימי והוא עוד לא בחר
מסלול או שילם, אז יכול להיות שעד שהוא כבר יקבל את האישור בדרך הוא מצא כבר חלופה אחרת ולא ימשיך
איתנו."* The longest wait in the flow had become the one stretch where he has decided nothing.

Both are answered by splitting one act into two: **he commits at ⑥ and pays at ⑧.** The card is
tokenised on our page and held (`lib/subscription-arm.ts`), PayMe are told nothing, and the first
charge fires the moment they approve — at which point the shop goes up in the same pass. He is
committed through the wait, pays for none of it, and never has to come back and press anything,
which is the zero-touch rule rather than a convenience.

**What makes it possible at all** is `PAYME_OWN_PUBLIC_KEY`: Hosted Fields need our own merchant's
public key, the §18 account was opened without keeping it, and a second one was opened on 2026-08-24
that did (`docs/payme-sandbox-notes.md` §24). With no key configured the whole thing degrades to
PayMe's own payment page, which is the older route and still works.

**Where the seller SEES this:** one screen, `components/dashboard/GoLiveSteps.astro`, on the
תשלומים tab. It states which shop it is about, which of the three money steps is open, "step N of
3", and a three-segment bar — *"שיהיה ברור ליוזר באופן גרפי, איפה הוא עומד"*.

| # | What happens | Owner | Today |
|---|---|---|---|
| 1 | Registers with email+password or Google. No card is asked for, ever, at this step | `lib/seller-auth.ts` · `/seller/register` | ✅ |
| 2 | Creates a store — name, latin slug, basics. Up to `MAX_STORES_PER_SELLER` | `lib/stores.ts#createStore` | ✅ |
| 3 | Builds it: products, images, variants, categories, discounts, coupons, design. No cap on any of it | `lib/store-products.ts`, `lib/discounts.ts` | ✅ |
| 4 | Looks at it. The shop is `unpublished` — the public cannot reach it, the OWNER can | `lib/store-status.ts` · `store-publication.ts#mayPreviewStore` | ✅ |
| 5 | Sends what PayMe require, and a clearing account is opened for his BUSINESS — one per ח״פ, however many shops | `lib/seller-merchant.ts` · `lib/merchant-kyc.ts` | ⚠️ owner (needs live PayMe) |
| 6 | Picks this shop's plan and saves a card on our page. **Charges nothing** — PayMe are not called at all | `lib/store-plan.ts` · `lib/subscription-arm.ts` | ⚠️ owner |
| 7 | PayMe examine the business — up to 7 business days (agreement §11). Nobody can shorten it; the seller is told he is finished and emailed when it clears | `lib/merchant-status-check.ts` | ⚠️ owner |
| 8 | **The card is charged and the shop publishes itself**, in one pass, with nobody present. Publication is the derived result of every hold clearing and of THIS shop being one of the lines on the standing order | `subscription-arm.ts#startArmedSubscription` · `store-publication.ts` | ✅ |

### A plan is bought PER SHOP, and there is still one charge

Decided 2026-08-24 — *"כל חנות צריכה לעלות כסף בנפרד"*. `lib/store-plan.ts` owns it:

- Each shop carries its own plan: its own monthly fee **and its own per-sale commission**. A tier is
  one bargain (a higher fee buys a lower commission), so splitting it would let a tiny shop on
  Enterprise collect the 10% rate for a large shop on Starter.
- The seller has **one standing order** at PayMe whose amount is the SUM of the shops he has on the
  site. Five separate subscriptions would pay five clearing fees for nothing.
- Putting a second shop up patches that one order upward; closing a shop patches it down. The
  breakdown is stored beside the amount, so *"why am I charged ₪224"* is answered on his own screen
  rather than reconstructed.
- **No extra terminal is needed at PayMe.** The clearing account is per registered business and
  serves every shop he owns; the commission travels per capture, so two shops of one seller on two
  plans are charged two different rates with nothing to configure at their end.

### Holds, and the one state they produce

**Three holds, one state, and that is deliberate.** A shop is held back by unfinished clearing
details, by PayMe not having approved yet, or by not being paid for. The consequence is identical —
he sees it, the public does not — so it is ONE state (`unpublished`) with three sentences, never
three booleans that can contradict each other.

**With no PayMe credentials configured at all, no hold applies and shops publish normally.** That is
the dev and pre-launch state, and it is why a fresh server does not look empty.

`syncStorePublication` is called from every place a hold can lift — the dashboard, the PayMe
callback, and the `store-publication` job — because a seller who paid, closed the tab and never came
back must not be left dark.

### Leaving, and being taken down

The other end of the same flow, built 2026-08-24. Both directions now exist; before this, cancelling
changed nothing anyone could see.

| What happens | When | Owner | Today |
|---|---|---|---|
| Seller cancels. He is shown the two things cheaper than leaving first — a lower plan, or taking ONE shop off the site — beside a cancel button of the same size | Any time | `SubscriptionCard.astro` · `/api/seller/subscription` | ✅ |
| Charging stops at PayMe **immediately** — there is no way to say "one more month then stop" | On the click | `seller-subscription.ts#endSubscription` | ✅ |
| He keeps everything until the end of the period he already paid for (`ends_at`, taken from PayMe's own next-charge date) | Until that date | `seller-subscription.ts#sellerIsSubscribed` | ✅ |
| His shops come off the site and return to `unpublished` — products, settings and orders all kept, campaigns archived, a notification sent | At `ends_at`, hourly sweep | `lib/subscription-lapse.ts` | ✅ |
| Renewing re-publishes them through the sweep that already exists | Any time | `store-publication.ts` | ✅ |
| **Refund on the FIRST charge: 14 days, if the shop never went live** — he paid and did not get the thing | 🔶 decided, unbuilt | needs the subscription iteration's sale id, which arrives with the PayMe callback | 🔶 |

Legally we are not obliged to offer one: חוק הגנת הצרכן covers a *consumer*, and a seller here is a
registered business. It is offered because the cost of the doubt is higher than the cost of the
refund — the whole flow is built against *"לא לבנות עכשיו חודשיים חנות ולהשאיר אותה עזובה"*.
⚠️ **Confirm the wording with the lawyer** who is already on `CURRENT_TASK.md → Next`.

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
| The money actually goes back, on the same call, on both legs | `lib/refund-execute.ts` (`refund_settled`) | ✅ |
| A leg that could not settle stays OPEN and is reported, never closed quietly | `lib/reconcile.ts` | ✅ |
| Buyer opens a return; statutory window; no cancellation fee, ever | `lib/returns.ts` · `/returns-policy` | ✅ |
| An order the seller never ships is warned at day 7 and cancelled at day 14 | `lib/order-sla.ts` + the `order-sla` job | ✅ |
| Buyer may review — the gate is a PURCHASE, never an account | `lib/review-eligibility.ts` | ✅ |
| Shipping labels, carrier pickup, return legs | — | 🔶 ⚠️ §5, courier not connected |

**The refund gap closed on 2026-08-23 and this table said otherwise until 2026-08-25** — worth
recording, because it is the failure mode the rule at the top of this file names: `refund-execute.ts`
shipped, and the line here that called it unbuilt was read by two sessions as if it were current.
What is left is not a gap but a floor: PayMe refuse a PARTIAL refund below ₪5, and a residue that
small is given back only by reversing the whole capture — that module owns the rule, and an amount
it cannot return stays open in the journal with the number in the log.

---

## 4. Money — who pays whom

**The platform never holds a shekel of a seller's money** (split model, 2026-08-21). PayMe capture
each store's share into that seller's own account as the charge happens and take our distribution
fee inside the same transaction.

| Flow | Direction | Owner | Today |
|---|---|---|---|
| Buyer → seller, per store | never through us | `lib/payment-split.ts` | 🔶 |
| Buyer → us, for shipping | our own merchant account | `lib/payment-split.ts` | 🔶 |
| Our commission | taken inside the sale, at THAT SHOP's plan rate, transferred monthly | `lib/store-plan.ts#commissionPercentForStore` · `lib/pricing.ts#commissionOnAgorot` | 🔶 |
| Seller → us, monthly subscription | PayMe recurring on his card — ONE standing order, its amount the sum of the shops he has on the site | `lib/seller-subscription.ts` · `lib/store-plan.ts` | 🔶 |
| Advertising | billed on actual spend + a disclosed margin, **never offset** against the above | `lib/ad-metrics.ts` | 🔶 |
| The buyer's tax invoice | **the SELLER's**, not ours | `lib/invoicing/buyer-invoice.ts` | ✅ (records that he says he issued one) |
| What the seller SEES: how much PayMe are about to move into his bank, and what they already moved | read live from PayMe, never our own accrual | `lib/seller-transfers.ts` · `/api/seller/transfers` | ✅ |
| What each sale really cost him: PayMe's clearing fee and OUR commission as two separate numbers, plus the net | their arithmetic, passed through | `payment-payme.ts#getSellerTransactions` | ✅ |
| The account-level monthly charges — the ₪50 minimum top-up, a chargeback, the terminal | — | 🔶 in no endpoint we have found (`docs/payme-questions-open.md` q4) |
| The seller switches PayMe's own invoicing on for himself, billed to him at cost | `lib/seller-invoicing.ts` | ⚠️ built; PayMe have not provisioned the service (q1) |

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
| Baseline ads for every product, platform-funded — **admin-only, never claimed to a seller** (owner, 2026-08-25: the promise was one we could not fund; the capability stays, silent). Seller-funded Boost is the only advertising a seller is told about | `lib/ad-baseline.ts` (admin surfaces only) · `lib/ad-campaigns.ts` · guard `tests/baseline-claim-silent.test.ts` | 🔶 no API connected |
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

**Decided and unbuilt:** shipping labels and carrier pickup, boost campaigns reaching a real ad API,
Meta's Conversions API, and the refund of a seller's FIRST subscription charge (§3.0.2 — the policy
is decided, the PayMe reference it needs arrives only on a callback we cannot yet receive).

**Waiting on the owner:** ח.פ, a live domain and host, PayMe going live, the Google/Meta accounts and
their two tag ids, `ALERT_EMAIL`, an uptime monitor. All of it, with what each unblocks, is in
`GO_LIVE_CHECKLIST.md → ⚠️ דורש אותך` — that index is the authority, and this file only points at it.
