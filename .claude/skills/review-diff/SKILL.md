---
name: review-diff
description: Review the working diff against this repo's own failure history — the bug classes that have actually shipped here. Use before reporting done on any change touching money, auth, inventory, cart, checkout, or admin/seller data. The Stop hook triggers this automatically; it can also be invoked directly.
---

# Review the working diff

`/code-review` and `/security-review` cannot be launched by the model — they are user-triggered only.
This is the model-side substitute, and it is deliberately **not** generic review advice: it is the list
of things that have actually broken in *this* codebase. A generic reviewer re-derives nothing; this
list is the accumulated cost of past sessions.

## How to run it

1. Get the diff. `git diff` plus `git status --short` for untracked files — much of this repo's work is
   uncommitted, so a diff against HEAD alone misses whole files.
2. Read every changed hunk. Not the summary, not the filenames — the hunks.
3. Walk the checklist below against what the diff actually touches. Skip sections the diff cannot
   reach, and say which you skipped and why.
4. For each finding: state the concrete failure (inputs → wrong result), fix it, and add or extend a
   test. Per AI_INSTRUCTIONS.md, a gap is never "out of scope" — fix on sight, then check whether the
   whole class has the same hole elsewhere.
5. Verify: `astro check`, `npm run lint`, `npm test`.
6. Record the review so the Stop hook lets the turn end:
   `bash .claude/hooks/record-review.sh`
7. Report what you checked, what you found, and what you skipped. If you found nothing, say that
   plainly — do not invent findings to look thorough.

## Checklist

### Money and reporting
- **A status value that excludes an order from revenue must be honoured by every reader.** Cancelled
  orders counted as revenue for seven sessions because the rule lived in several modules. Adding or
  changing a status means grepping every reader of that field. `lib/reconcile.ts` computes the same
  figures a second way — if it disagrees, trust it over the code you just wrote.
- **Prices are recomputed server-side, never taken from the client.** The cart is client state and
  every API route is directly callable.
- **Anything that moves money or decrements stock needs a Vitest test in the same change.** Not
  follow-up work — the same change.
- **Rounding goes through `lib/money.ts`.** Float equality on money is a defect, not a style choice.

### Untrusted input
- **Every request-supplied destination goes through `lib/safe-redirect.ts`** — `?next=`, a cookie
  carrying one, a `Referer`. This was copy-pasted into four routes and missing from a fifth, which is
  how `/api/lang` became an open redirect.
- **Every email intake goes through `lib/email-address.ts`.** Length cap before pattern.
- **A regex with two `+`/`*` runs that can match the same character, applied to request data, is a
  denial-of-service vector.** Measure it — double the input, watch the time quadruple. Do not
  eyeball it. See `lib/url-base.ts` for why an anchored `X+$` is not safe on a request path.
- **Bounds and types are checked on the server even when the UI already checks them.** A disabled
  button is not a rule.

### Escaping and injection
- **An escaper used inside `attr="…"` must escape `"`.** Skipping it is the exact hole fixed at
  `escapeHtml`/`escH`.
- **`set:html={JSON.stringify(data)}` inside a `<script>` is an XSS sink** — `</script>` is not
  escaped by `JSON.stringify`. Use `lib/json-script.ts`.
- **Every image URL from a request goes through `lib/image-url.ts`** (`sanitizeImageUrl` /
  `sanitizeImageUrls`, or `parseImages` for a product form). It validates by SHAPE — https or
  site-relative — and stores the URL parser's own serialization, so `"`, `<`, `>` and space come
  back percent-encoded and an attribute breakout is impossible even if a call site forgets to
  escape. `tests/image-url.test.ts` greps `src/` and fails if a new route assigns an image field
  straight out of a request. A URL is still not a promise about the bytes behind it, so treat the
  fetched content as untrusted.

### Authorization and scoping
- **A record replayed or returned to a caller must be bound to that caller.** A hard-to-guess
  identifier is not authorization — see `checkoutOwner` in `lib/checkout-idempotency.ts`.
- **Multi-store orders must never leak one seller's data to another.** `scopeOrder` exists because
  the whole `sellerNotes` map used to go to the client.
- **A seller may not act on a store they do not own.** Check ownership from the session, not from a
  slug in the request.

### Architecture
- **A rule that appears in two modules is the next bug.** Extract it and add a grep guard test that
  fails if anyone hand-rolls it again — `tests/safe-redirect.test.ts` and
  `tests/email-address.test.ts` are the pattern.
- **Astro built-ins and existing `src/lib` modules before a new parallel mechanism.** Two systems for
  one job fight each other.
- **JSON files are dev-only and must stay swap-ready for the DB.** No shared write state. Ask whether
  it breaks at 1000 sellers.

### Correctness traps specific to this codebase
- **`.astro` attribute expressions**: `attr="text" + (expr)` is not valid — it silently becomes junk
  attributes and the expression vanishes. Use `attr={`…${expr}`}`. This shipped once.
- **`toggle('hidden')` is a no-op on a flex element here** — use `'!hidden'`.
- **A save must never revert a field the seller did not touch** (`lib/record-rev.ts`, per-field merge).
- **New dashboard forms needing a real browser POST must carry `data-native-submit`**, or
  `FormFallbackGuard` blocks them.

## Area audit — one row per session (user's decision 2026-08-06, in force from the session after it)

Everything above reviews a **diff**. That is a net for code being written now, and it has never once
looked at code nobody has touched since it shipped — which is where the 2026-08-06 feed bugs lived:
the feed worked, its own tests passed, and four attributes had been wrong on **every variant row**
from the day it was written. No diff ever contained them, so no review could have.

So each session also does the row for the area it worked in. **Side-work, not the main task** — if a
row turns out to be a project, say so in the summary and leave it unmarked rather than half-doing it.

**What "audited" requires**, all three:
1. Read the area's modules **end to end** — not the diff.
2. Check them against what the **outside world** demands: a published spec, a permission rule, a
   browser constraint, a payment-provider contract. The failure shape here is always the same — each
   side internally consistent, only the JOIN wrong — so testing what we *meant* cannot find it.
3. Leave a **guard test that scans the whole tree**, so the class cannot return. The pattern:
   `money-guards`, `image-optimization`, `safe-redirect`, `secret-compare`, `feed-spec-conformance`.

Then mark the row here, in the same session, with the date and the test that now holds it.

| # | Area | Audited |
|---|---|---|
| 1 | Feed + advertising — the Merchant/Catalog contract | ✅ 2026-08-06 · `feed-spec-conformance.test.ts` (Google AND Meta; they are not one list). Same day, the campaign side of it: a boost read "פעיל" while advertising nothing — now a third self-healing pause reason, held by `resumeBlockCode`'s guard test across both routes and both locales |
| 2 | **Money: orders, commissions, balances** | ✅ 2026-08-07 · `money-owed-guards.test.ts` (tree scan) + `checkout-e2e.test.ts` (16 cases against a real DB). Read end to end against ONE outside contract — **money leaves a real person's card, so something must always say where it stands.** The arithmetic was already sound and `reconcile.ts` already proved it two ways; what nothing could see was money that MOVED with no row behind it, because both of its routes read the same order tables. The journal is the independent record, so the audit's output is a second reconciliation family comparing the two. Three states, each reachable and each silent: (a) a seller cancels a PAID order — stock back, order out of every revenue sum, buyer told "cancelled", and the captured money simply stays with us, its only trace a status row whose meaning a reader had to infer; `refund-owed.ts` writes `refund_due` the moment the debt exists, and `PAYMENT_STATUS_RULES.moneyWasTaken` is the column that makes "was a person's money taken" a different question from "does this earn anyone anything today"; (b) the capture never completes — rows sit `pending` forever with stock off the shelf, no notification, and possibly a real charge; (c) an authorization with no order and no void, the 0017 shape, now a live check rather than a story. Also found: capture succeeded and the seller notification failed with **no trace anywhere** — both notification catches log now, under `notify:*` rather than `/api/checkout`, so a badge failure cannot page a person for a checkout that worked. `refund_settled` exists and nothing writes it **on purpose**: it needs the provider's refund call, so every obligation stays open and visible instead of quietly closing itself — ⚠️ GO_LIVE §3 carries the row, and until a provider is wired each line on that card is money to return by hand. History, unchanged: `orders.payment_ref` was UNIQUE while one charge becomes one order row PER STORE, so every multi-store checkout 500'd (0017), and the flow charged before writing orders — now authorize → `pending` rows → capture (`lib/payment.ts`). No test caught it because nothing ran `/api/checkout` against a real database. |
| 3 | Inventory + checkout | partial · atomic decrement proved under 50 concurrent buyers. **2026-08-10 added one tree-scanning guard to this area but did NOT audit it** — `money-owed-guards.test.ts` now demands the STOCK half of a status move as well as the money half: every module that writes a shipping status must restock through `orderHoldsStock` or hand the move to `order-status-change.ts`. It was written because an automatic canceller now exists (`order-sla-run.ts`), so "the job restocks and the dashboard restocks" became two places that could drift. **What is still unaudited is the area** — the checkout's own decrement/rollback path, variant pooling, and what an oversell actually looks like from the buyer's side, read end to end against an outside contract rather than against our own tests |
| 4 | **Authorization — who may READ and who may WRITE what** | ✅ 2026-08-06 · `store-ownership.test.ts` (two tree scans) + `safe-redirect.test.ts` (`_next`) + `oauth-verified-email.test.ts`. All 46 `/api` routes, both session modules, middleware/CSRF and every seller/admin/buyer page read end to end against one rule: **a session proves which STORES an account owns, never which id it may name.** Three holes, all fixed. (a) `seller/dashboard.astro`'s no-JS fallback POSTs authorized NOTHING — any signed-in seller could rewrite another store's price and stock, delete its products, or file products into it. The `/api/*` twins had checked all along, which is precisely why no diff review could ever have found it, and why this row exists. (b) Google OAuth fetched `verified_email` and never read it, while the branch below links a matching address into an existing account — takeover. (c) The hidden `_next` field bypassed `safe-redirect` on login + register while `?next=` did not. `?? stores[0]` on both save-settings paths also let an unrecognised id overwrite a different shop of the seller's own |
| 5 | Domains + the origin boundary | partial · `cross-origin-boundary.test.ts`; ad-landing crossing closed 2026-08-06. **2026-08-10 closed one more seam but did NOT audit the area** (`checkout-handoff-freshness.test.ts`): the cart travels to `/checkout` in the link's fragment, and the fragment was built when the link was REWRITTEN — once, at load. So the two checkout buttons that are *revealed* by add-to-cart always carried the empty basket the shopper landed with: on a seller's own domain the ordinary buy path ended at a checkout with nothing on it, silently, because every piece was correct on its own. Re-scanning cannot see it (`cross()` only touches root-relative hrefs, and these are absolute once crossed), so the fragment is re-stamped at click time by a delegated capture-phase listener — which is what makes a checkout link nobody has written yet immune. Swept the class rather than the instance: only two pages are reachable on a custom host and both install it, the four other checkout links are injected (so rewritten fresh) and now also pass through it, and the one other href built from client state (the reports CSV export) is rebuilt on every filter change. **What is still unaudited is the rest of the area** — the 301 family, `store_previous_domains`, per-host `robots.txt`, the platform/store origin split — and the guard here tests the function rather than scanning the tree |
| 6 | SEO surfaces: sitemap, canonical, robots, structured data | ☐ per-file tests exist; never audited AS one surface |
| 7 | **Dashboard: forms, parallel tabs, draft recovery** | ✅ 2026-08-09 · `field-repaint-guard.test.ts` (tree scan). The owner reported one symptom — a recovered draft put an image URL back and the picture did not return — and the sweep found it was a CLASS, not a card. `announceValueChange(field)` is a widget saying "I wrote this without firing an event", which is only ever true of a widget keeping its state IN a field and its picture in the DOM; exactly those widgets break when the traffic runs the other way and the form replaces the field (`dash:fieldsrewritten`). Four were missing the listener — the header-logo card, the sale-scope picker, the product multi-picker and the product gallery — all correct in `store-image.ts`, where the rule was learned, and missing in every place it was learned again. **The multi-picker's was the one that could lose data rather than merely look wrong:** it reads the field into a `Set` once at init, so the seller's next tick wrote that stale set back over the value the restore had just put there, silently undoing the recovery. Also fixed from the same report: "restore" scrolled to the FORM, and the settings form is the whole tab, so `block:'center'` landed near its midpoint — a confident movement to a place with nothing to see, which teaches a seller to distrust the restore. `apply()` now reports the first field it actually CHANGED (compared before the write — a draft carries every field, so most of that loop assigns what is already there) and the scroll goes to that field's own card; a hidden input resolves to its nearest labelled container, and with none the page does not move at all. Not audited here: parallel-tab conflict merging (`record-rev.ts`), which this session only extended by two fields |
| 8 | Graceful degradation — no secondary service in a critical path | ☐ |
| 11 | **What a failure LOOKS like — every surface that can tell a user something went wrong** | ✅ 2026-08-10 · `silent-failure-guard.test.ts` (tree scan over `src/scripts/**` + every `.astro` client script). Read against one outside rule rather than against our own intent: **a person who pressed a button is owed an answer, and a request that never arrived has not earned the right to make a claim about the store.** All 27 `fetch` call sites walked. Sixteen were right; eleven were the same habit — a `catch` written while getting the happy path working and never revisited — and from the user's side every one of them is the same event: the button re-enables, the screen looks idle and correct, and they carry on believing it worked. Two classes. **Dead actions:** four message sends, an order status save (both entry points), a CANCELLATION (which also restocks and drops the order out of every revenue figure), a note save and a note delete, filter/sort/page on orders+products+messages, and the ad campaign list, which also threw an unhandled rejection. **Failures dressed as facts about the catalogue:** the store grid's "טען עוד" hid its own button (announcing "that is the whole catalogue"), a category filter blanked the grid, header search said "no results", the coupons list rendered its empty state, the performance breakdown said "no sales in this period". **The one that mattered most was structural:** `ConfirmModal` is the funnel EVERY destructive action goes through and ran `try { await action() } finally { close() }` with no `catch` — a delete whose fetch was dropped closed the dialog exactly as a success does, with the only trace an unhandled rejection. One catch covers twenty-one actions. Bulk product delete counted nothing and claimed everything ("the products were deleted" for twenty when three were refused); it now tallies and leaves the failures selected, so pressing delete again retries exactly them. Deleting a notification removed the card first and swallowed the result, so it reappeared on the next load looking like the site undoing the user's action. **The guard's shape is the durable part:** it does not ban silence — a background poll, an enrichment, a return whose caller renders the error — it bans silence that was never DECIDED, so each of the thirteen legitimate ones now carries a `silent:` marker and a reason. Also pinned: the ConfirmModal catch, and one wording (`showActionFailedToast`) for an event that had six hand-written Hebrew sentences. Not audited here: the server side — what an API route does when its own dependency fails |
| 9 | **Behaviour under load** | ✅ 2026-08-09 · read end to end — `db.ts` (pool, three timeouts, wake retry, saturation), `shutdown.ts`, `single-flight.ts`, `health.ts`, `jobs/scheduler.ts` + `job-runs.ts`, `process-errors.ts`, `error-log.ts`, `page-view-tap.ts`, `middleware.ts` — against what the outside actually promises rather than what we assumed: Neon's plan page (Free PITR is **6 hours**, and Neon has moved to **Postgres 18.4**), R2's pricing, and undici's real behaviour. **The operational layer held up**; what did not was two things nobody had looked at because no diff contained them. (a) `analytics_visitors` and `store_page_view_visitors` grew with traffic and nothing deleted them — fixed, `purge-visitor-detail` + a tree scan in `visitor-retention-db.test.ts` so a second `DELETE` cannot skip the `AUX_EVENTS` carve-out. (b) **Closed later the same day, and it was the whole reason this row sat at partial:** `/api/feed/products.xml` and `/sitemap-content.xml` built the whole catalogue in memory per request on one event loop — `products.xml.ts`'s own note said this becomes a cached artifact once the DB migration lands, the migration landed 2026-08-03, and it did not. `single-flight` + a 1h `Cache-Control` restrained it, which is why it read fine at 45 stores and would not have at a thousand. **The shape of the fix is the part worth remembering: moving a build off the request path is only half of it.** The jobs run in the SAME process, so a job that built the document in one allocation would block the same event loop, just on a schedule — it is the chunking that fixes that, and the chunking is what bounds the memory too. So: 20 stores per window, a flush every ~256KB, and every flush an `await` that hands the loop back (`lib/artifacts.ts`, migration 0022). Two things make it hold: the guard this row asked for — `public-route-unbounded-build.test.ts` scans `src/pages/` for the SHAPE (enumerate every store + read a catalogue keyed by that list), not for the two files that were fixed — and a byte-for-byte equality test against the serialiser it replaced, composed from the same per-store functions the build uses so it cannot quietly stop asserting. Measured on the built server after getting the read side wrong once: a part per query served a 2.5MB feed in 3.3s, a window of eight took it to 2.1–2.5s, and the remainder is the document crossing the network from Neon rather than latency. GO_LIVE §7. **And the second bug the first one uncovered, fixed the same day:** one sitemap FILE may hold no more than 50,000 URLs (checked against sitemaps.org, not recalled) and is rejected WHOLE above that — so at the very scale this work was for, the symptom would have been a platform with no content sitemap and no error anywhere. `/sitemap-content.xml` is a `<sitemapindex>` now, over shards cut at 45,000; the index is written even for one shard, because a document shape that changes itself the first time a threshold is crossed arrives unannounced at the worst possible moment. A shard a rebuild did not write is deleted, not left serving a slice of a catalogue that no longer exists, and an out-of-range shard is 404 rather than a retry-forever 503. Also never measured: the Node process itself under HTTP load (memory, event loop, TTFB) — §9's 500-concurrent test was queries against Neon, not requests to a server, and it cannot be run before a host exists |
| 10 | **RTL + i18n** | ✅ 2026-08-07 · `i18n-hardcoded-strings.test.ts` (two tree scans). `translations.ts` + `getT` + the `#i18n-data` island + every consumer read end to end against two outside rules: **a page that declares `lang`/`dir` must render in that language**, and **a control that names a direction on screen must mirror with `dir`**. The gap was never an untranslated screen — those fail loudly. It was surfaces that are 95% translated: the notification panel rendered from `t.notifications` while the rows its script wrote into it were inline Hebrew; the same shape in the compose dialog, the thread row (BOTH renderers), the store/product pages' client toggles, checkout's quantity stepper and the seller's whole edit-order modal. **In three of them the dictionary already held the exact string** — each side right, only the join missing. Also the product lightbox's arrows, the last horizontal pair still on physical `left`/`right`, so in Hebrew they sat opposite the arrow keys (`arrow-step.ts`) and opposite every other carousel here. The guard's discriminator is the thing that made this a project rather than side-work: a file that calls `getT(` is a bilingual surface and every literal in it must be a lookup, a `??` fallback (188 of those are legitimate) or a `lang` conditional; a file with no `getT(` is Hebrew-only by construction, so it needs no allowlist. **Left open, and it is a measurement job rather than a translation one:** `BrandLogo.astro`'s drawn tagline. Its `aria-label` — the homepage `<h1>`'s whole accessible name, so what a crawler and a screen reader get — now follows `t.home.startSelling` like any other string. The *drawn* line under the wordmark stays Hebrew because its size and margin were bisected against a real build across 11 viewports × DPR 1/2/3 to sit flush with the mark: it is a solution for those 19 glyphs, not text, and a Latin run needs all three values re-solved (the instruction is above the span) |

**Which row to take is not the session's choice any more (2026-08-10).** Every ✅ above was
marked by the session that happened to be working in that area — which is the cheap half, and the
half that finds the least: an area you have just spent a day inside is the one you least need to
re-read. The rows that stayed open are the ones nobody had a reason to open, which is precisely
the condition the feed bugs lived under. `.claude/hooks/next-area-audit.sh` now names the
lowest-numbered open row at session start, before any work has created an opinion about which
area is interesting. It does not block; it removes the discretion that was quietly selecting for
the areas least worth auditing.

**A ☐ does not mean untested.** The repo has 209 test files and ~2,690 tests, and every area above is
covered by some of them. It means nobody has read that area *as a whole against its outside
contract* — which is the specific gap this table closes, and the one the feed's own passing tests
did not.

## What this cannot do

It reads a checklist; it does not read intent the way a person does, and it will miss a class nobody
has written down yet. When a change is large or genuinely novel, say so and suggest the user run
`/code-review` for an independent pass. Never claim that ran.
