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
| 2 | Money: orders, commissions, balances | partial · `reconcile.ts` + `reporting-invariants` + `reporting-fuzz`. **2026-08-07 fixed a hole rather than auditing the area, and the distinction is the point:** `orders.payment_ref` was UNIQUE while one charge covers a cart that becomes one order row PER STORE, so every multi-store checkout 500'd (migration 0017) — and the flow charged BEFORE writing orders, so each of those was, against a real gateway, money taken for an order that does not exist. Now authorize → order rows ('pending') → capture, with `voidCharge` releasing the hold on any failure (`lib/payment.ts` header). Why no test caught it: nothing ran `/api/checkout` against a real database — `checkout.test.ts` mocks the entire orders module, so a constraint could not fail in it. `tests/checkout-e2e.test.ts` closes that. **The row stays PARTIAL:** the owner asked (2026-08-07) for the real sweep — every edge case where money and what a seller/buyer can SEE disagree (a charge no seller ever sees, a capture with no notification, a cancelled slice still counted, a refund with no trace). That needs the whole-tree guard test this table demands, and it has not been done. |
| 3 | Inventory + checkout | partial · atomic decrement proved under 50 concurrent buyers |
| 4 | **Authorization — who may READ and who may WRITE what** | ✅ 2026-08-06 · `store-ownership.test.ts` (two tree scans) + `safe-redirect.test.ts` (`_next`) + `oauth-verified-email.test.ts`. All 46 `/api` routes, both session modules, middleware/CSRF and every seller/admin/buyer page read end to end against one rule: **a session proves which STORES an account owns, never which id it may name.** Three holes, all fixed. (a) `seller/dashboard.astro`'s no-JS fallback POSTs authorized NOTHING — any signed-in seller could rewrite another store's price and stock, delete its products, or file products into it. The `/api/*` twins had checked all along, which is precisely why no diff review could ever have found it, and why this row exists. (b) Google OAuth fetched `verified_email` and never read it, while the branch below links a matching address into an existing account — takeover. (c) The hidden `_next` field bypassed `safe-redirect` on login + register while `?next=` did not. `?? stores[0]` on both save-settings paths also let an unrecognised id overwrite a different shop of the seller's own |
| 5 | Domains + the origin boundary | partial · `cross-origin-boundary.test.ts`; ad-landing crossing closed 2026-08-06 |
| 6 | SEO surfaces: sitemap, canonical, robots, structured data | ☐ per-file tests exist; never audited AS one surface |
| 7 | Dashboard: forms, parallel tabs, draft recovery | ☐ |
| 8 | Graceful degradation — no secondary service in a critical path | ☐ |
| 9 | Behaviour under load | ☐ |
| 10 | **RTL + i18n** | ✅ 2026-08-07 · `i18n-hardcoded-strings.test.ts` (two tree scans). `translations.ts` + `getT` + the `#i18n-data` island + every consumer read end to end against two outside rules: **a page that declares `lang`/`dir` must render in that language**, and **a control that names a direction on screen must mirror with `dir`**. The gap was never an untranslated screen — those fail loudly. It was surfaces that are 95% translated: the notification panel rendered from `t.notifications` while the rows its script wrote into it were inline Hebrew; the same shape in the compose dialog, the thread row (BOTH renderers), the store/product pages' client toggles, checkout's quantity stepper and the seller's whole edit-order modal. **In three of them the dictionary already held the exact string** — each side right, only the join missing. Also the product lightbox's arrows, the last horizontal pair still on physical `left`/`right`, so in Hebrew they sat opposite the arrow keys (`arrow-step.ts`) and opposite every other carousel here. The guard's discriminator is the thing that made this a project rather than side-work: a file that calls `getT(` is a bilingual surface and every literal in it must be a lookup, a `??` fallback (188 of those are legitimate) or a `lang` conditional; a file with no `getT(` is Hebrew-only by construction, so it needs no allowlist. **Left open, and it is a measurement job rather than a translation one:** `BrandLogo.astro`'s drawn tagline. Its `aria-label` — the homepage `<h1>`'s whole accessible name, so what a crawler and a screen reader get — now follows `t.home.startSelling` like any other string. The *drawn* line under the wordmark stays Hebrew because its size and margin were bisected against a real build across 11 viewports × DPR 1/2/3 to sit flush with the mark: it is a solution for those 19 glyphs, not text, and a Latin run needs all three values re-solved (the instruction is above the span) |

**A ☐ does not mean untested.** The repo has 209 test files and ~2,690 tests, and every area above is
covered by some of them. It means nobody has read that area *as a whole against its outside
contract* — which is the specific gap this table closes, and the one the feed's own passing tests
did not.

## What this cannot do

It reads a checklist; it does not read intent the way a person does, and it will miss a class nobody
has written down yet. When a change is large or genuinely novel, say so and suggest the user run
`/code-review` for an independent pass. Never claim that ran.
