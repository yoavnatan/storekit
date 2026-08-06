---
name: project_payme_api_verified
description: "PayMe's real API, read in full 2026-08-06 from the raw Blueprint — market_fee IS our commission, there is NO multi-seller split, and the docs URL that actually works"
metadata: 
  node_type: memory
  type: project
  originSessionId: bb2acdb1-3007-45d5-8d0a-69ccd293715e
  modified: 2026-08-06T19:24:54.987Z
---

**Read the Blueprint, not the docs site.** `https://paymeapi.docs.apiary.io/api-description-document`
returns the whole 82KB API Blueprint as plain text. `payme.stoplight.io` / `docs.payme.io` are SPAs
that serve an empty shell to any fetch — that is what made an earlier session record "הסכמות לא
אומתו" and defer the whole decision. One URL was the difference.

**11 endpoints, all POST + JSON**, against `sandbox.payme.io/api/` or `live.payme.io/api/`:
create-seller · upload-seller-files · withdraw-balance · generate-sale · refund-sale ·
generate-Subscription · cancel-Subscription · get-sellers · get-sales · get-subscriptions ·
get-withdrawals.

**`market_fee` is exactly the platform's cut** — a percent (0–60, VAT included) charged on top of
PayMe's own fees and **transferred to the marketplace monthly**. Default per seller at create-seller,
overridable per sale. So the 12% is taken INSIDE the transaction and the money never passes through
the platform — §3's regulatory constraint is satisfied by the provider's own design, not by a promise
we have to keep. The 99₪ subscription is NOT covered by it (it is a percent of a sale, not a plan) —
that stays our own billing mechanism ([[project_business_model_pricing]]).

**⚠️ There is NO multi-seller split.** `generate-sale` takes a single `seller_payme_id` and no split
endpoint exists — the "split a transaction between multiple sellers" line is marketing, not API. **A
cart with three stores is three transactions.** Per-store checkout was written up as the fallback; it
is now the route, and it is also the safer one (no partly-paid order). This is a UX decision the
checkout has to reflect.

**"One click for three stores" — researched hard 2026-08-06, and the answer is no (as far as public
material goes).** Three independent signals, and they agree that even the token is seller-scoped, so
the workaround ("card entered once, charged three times in the background") is unproven too:
1. `generate-sale` takes one `seller_payme_id`; no split endpoint exists. Verified against their
   **live mock server**, `https://stoplight.io/mocks/payme/payments/202059897`, which validates
   against the real spec — `split-sale` / `multi-sale` / `marketplace-sale` all "no path matched",
   while `generate-sale`, `capture-buyer-token` and `get-buyer-key` resolve.
2. `capture-buyer-token` **requires** `seller_payme_id` — the token is created under one seller.
3. Their official `github.com/PayMeService/integration-example` (updated 2026-06) states the Hosted
   Fields SDK is initialised with `seller_payme_id` as the tokenisation **auth token**.

**So: build per-store checkout.** It works either way, it is the safer shape (no partly-paid order),
and it is not throwaway — if a cross-seller token turns out to be allowed, one layer on top merges
it into a single screen. The question to settle (`partners@payme.io`, or testable alone in sandbox
once keys exist): can a token captured under seller A be charged for seller B on the same platform?

**Also found:** Apple Pay, Google Pay, 3D Secure, invoices and recurring payments are all supported.
The newer doc set at docs.payme.io ("2. Payments") is richer than the Apiary Blueprint and includes
Merchants Management / Buyers Management / Tokenization — but it renders client-side only; the mock
server and the GitHub example are the readable ways in.

**`create-seller` is full API onboarding, and it sets the signup wizard's field list:** ת.ז +
issue date + birthdate + gender, mobile, **bank code/branch/account**, incorporation type + ח.פ +
registration date, business address, MCC, description. Plus `upload-seller-files` and a callback on
seller create/update. **`withdraw-balance`**: balances sit at PayMe per seller and we decide when they
are drawn.

Also verified: **Bit is supported** (`sale_payment_method`, unlike the SUMIT plugin's limitation) ·
IFRAME/Hosted Fields so PCI scope stays out · MD5 callback signature
`md5(client_key + merchant_secret + transaction_id + sale_id)`, and their own docs say to verify
against the transaction rather than trust the signature alone · minimum sale 500 (5.00₪), amounts in
agorot like ours · **a full sandbox with decline/blocked/stolen test cards, so the whole integration
is buildable and testable before any live account.**

**Status 2026-08-06: he emailed PayMe and is waiting on sandbox keys. Until they arrive, do not
change the checkout strategy and do not build the payment layer** — his explicit call. A sandbox does
NOT require a ח.פ (an earlier note here overstated that): keys sit in a PayMe account's Settings with
a separate test-mode key, an ordinary account opens on an ID plus proof of bank account ownership,
and `create-seller` itself accepts a sole proprietor or private individual. A ח.פ blocks taking real
money, not developing.

Still only answerable by them: the actual rate, whether signup can be embedded in our own flow, and
whether invoices connect to חשבוניות ישראל / מספר הקצאה. Credentials (`payme_client_key`,
`payme_merchant_secret`) come from an account manager after applying at payme.io.

Related: [[project_payment_provider]], [[project_launch_three_conditions]], [[project_business_model_pricing]]
