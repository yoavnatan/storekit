# PayMe — what was measured, and how to measure it again

**Everything here was produced by real calls against `https://sandbox.payme.io/api/` on 2026-08-21.**
Nothing in this file is recalled, inferred from a marketing page, or carried over from an earlier
session. Where something is *not* measured it says so.

This file exists because the same wrong turn was taken twice: PayMe's guide pages
(`payme.stoplight.io/docs/guides/…`) are a JavaScript application that returns a title and no body
to any fetch, so a session that needs a fact reaches for the readable spec instead — and the
readable spec is **old**. It does not know `pay-sale`, `update-seller`, `market_fee_fixed` or
multi-capture. A session that trusts it will conclude, confidently and wrongly, that a cart cannot
span several sellers.

- `payme-api-blueprint.md` (beside this file) is that raw spec, saved verbatim. **Use it for the
  shapes it does describe and never as evidence that something does not exist.**
- The numbers in the partner agreement — fees, settlement dates, what is billed to whom — are in
  `GO_LIVE_CHECKLIST.md` §3.1.0.
- The measurements below are summarised in `GO_LIVE_CHECKLIST.md` §3.1.1. This file is the working
  copy: how to reproduce them, and what the responses actually looked like.

---

## Credentials

`PAYME_CLIENT_KEY` and `PAYME_SELLER_API_ID` live in `.env` (in no repo — `CLAUDE.md` §restore).
Every call is `POST` + JSON to `<base><endpoint>` with `payme_client_key` in the body.
Base: `https://sandbox.payme.io/api/` for staging, `https://live.payme.io/api/` for production.

## ⚠️ The sandbox is shared with other partners

PayMe said so in writing, and it showed: **13 sellers already existed before we touched it.** There
is no delete. So:

- Create the minimum. Two test sellers exist for us and that is enough — `Dezabin TestA`
  (`MPL17873-13741TOF-ET7YURJJ-DOZ4LSGO`) and `Dezabin TestB` (`MPL17873-13773IVT-PXWKVCT1-QAW9P2LJ`).
- Use **their** documented test values, never a real person's: social id `9999999999`, email
  `random@paymeservice.com` (their own note: this address receives no automated mail), bank
  `54 / 123 / 123456`. Phones in an unallocated range (`+9725000000xx`) so no stranger is texted.
- Test cards are in the blueprint: `12312312` is the local Israeli card; a separate series returns
  declined / blocked / stolen / expired / wrong-CVV on demand.

## Reproducing a measurement

The probe used was ~30 lines: read `.env`, POST the endpoint, redact the key out of the response
before printing. Two shapes are worth keeping in mind rather than in a file:

- **Endpoint discovery** — POST with only the client key. `"Required parameter is missing"` plus the
  field name means the endpoint EXISTS and just told you its first required argument. An HTML body
  means it does not exist.
- **Field discovery** — fill in the field it named and POST again. The API walks you through its own
  required set, one error at a time, without creating anything.

## What exists

`create-seller`, `update-seller`, `upload-seller-files`, `get-sellers`, `generate-sale`, `pay-sale`,
`capture-sale`, `refund-sale`, `capture-buyer-token`, `get-sales`, `generate-subscription`,
`cancel-subscription`, `get-subscriptions`, `withdraw-balance`, `get-withdrawals`.

**Not found:** `split-sale`, `multi-capture`, `void-sale`, `cancel-sale`.

## The measurements

### 1. `pay-sale` is open to us — the integration is testable without a browser
It takes `credit_card_number` and charges server-to-server. So the whole flow can be exercised in
tests with their test cards. **Production stays on Hosted Fields / IFRAME** — this is a testing
affordance, not the shipping integration, and using it live would put us in PCI scope.

### 2. ✅ A buyer token created under one seller charges under another
This is the mechanism behind "one cart, several stores", and it was the open question the checkout
design had been waiting on since 2026-08-06.

    capture-buyer-token  { seller_payme_id: A, credit_card_number: 12312312, … }  → buyer_key
    generate-sale        { seller_payme_id: B, buyer_key, sale_price: 500, … }    → completed

### 3. ⚠️ A token is single-use unless you ask for a permanent one
The second charge on the same key returned `Buyer inactive`. Passing
`buyer_is_permanent: true` to `capture-buyer-token` fixes it, and returns the same `buyer_key`
upgraded rather than a new one. **A multi-store cart is broken without this flag** — store one
succeeds and store two fails.

### 4. ⚠️ Multiple captures are not enabled on our key
Authorize ₪100 (`sale_type: "authorize"`), capture ₪40 → the sale jumps straight to `completed` and
a second capture is refused `305 · Cannot perform action due to an incorrect status`. Capturing
above the authorization is refused too: ₪11 against a ₪10 authorization →
`352 · Invalid price, out of min-max bounds`. **The cart does not need this** (the token route
above), but **charging advertising by actual spend does** — that is one authorization drawn down
over a month.

### 5. ✅ `market_fee_fixed` exists — a fixed amount beside the percentage
This is what carries the delivery charge to us so we can pay the courier.
**⚠️ Unit trap: `sale_price` is in AGOROT and `market_fee_fixed` is in SHEKELS.**
Measured on one sale: `sale_price: 5000` (₪50) with `market_fee: 12` and `market_fee_fixed: 15`
returned `sale_market_fee_total: 2100` — ₪6 percentage + ₪15 fixed. Sending `3000` meaning ₪30 is
read as ₪3,000.

### 6. ⚠️ Our total cut is capped at 60% of the sale
₪50 with a ₪30 delivery charge is 72% and was refused:
`Market fee exceed allowed maximum of 60%`. A cheap item with a real delivery charge is exactly the
case that breaches it. **This is why shipping is charged as its own sale on our own merchant
account instead** — that route touches no ceiling at all, and was measured working: a ₪30 sale under
a second account with `market_fee: 0`, paid with the same token, completed.

**✅ RESOLVED 2026-08-23 by the owner producing the actual exchange with PayMe. Two sessions had
guessed at this and the second guess — mine — was wrong; the record is below so nobody guesses a
third time.**

The owner asked them, verbatim:

> *"האם בפיצול ניתן להגדיר גם סכום דינמי שלא מחושב באחוזים מהעסקה? (למשל — דמי משלוח שהקונה משלם
> ואני צריך שיעברו אליי כדי שאשלם לחברת המשלוחים)?"*

PayMe answered:

> *"כן. זה אומר שכשאתה עושה לכידה בשווי 500 ש״ח שהם 100%, אני צריך להעלות לך את האפשרות בהגדרות
> אצלי ל‑110% לדוגמה."*

**So the "110%" IS about our cut, not about capture-versus-authorization.** The question was
explicitly about a FIXED amount for delivery — `market_fee_fixed` — and the answer is yes, plus:
the cap on the total distribution fee is **a per-account setting on their side that they can raise
on request.** The 60% we measured is simply its current value on our account.

What this corrects, in both directions:
* An earlier session guessed the 110% applied to the market fee. **That guess was right**, and it
  was marked "a READING, not a measurement" — correctly, because it was one.
* On 2026-08-23 I argued the opposite: that he must have meant the capture ceiling, since 110% of a
  sale as commission is arithmetically absurd. **That reasoning was wrong** — he is talking about
  the ceiling SETTING's value, not about taking 110% of a sale — and it was written into this file
  and into `GO_LIVE` with more confidence than an inference deserves.

**The consequence is a real design option, not a footnote.** Folding delivery into the seller's sale
as `market_fee_fixed` is now known to be available, and it would remove one line from the buyer's
card statement on every single-store order. It is not automatically the right choice — see
`GO_LIVE` §3.1.2 for the three costs (refund entanglement, a blended fee figure that has to be
decomposed per order, and their settlement date) — but it is a live choice, and it was previously
recorded as closed.

### 7. `create-seller` returns more than an id
`seller_payme_id`, `seller_payme_secret` (the per-seller callback signing key),
`seller_public_key` (for Hosted Fields), and **`seller_dashboard_signup_link`** — a link the seller
completes his own details on. So we do not have to collect every KYC field ourselves; we can create
with the minimum and hand him the link. **Our own `seller_id` correlation field is refused on this
plan** (`790`), so the join is the `seller_payme_id` we store. A new seller is
`seller_approved: false` / `Restricted` until they approve him.

### 8. Defaults visible on the account
Processing `2.50%` + `₪0.70`; foreign `3.15%` + `₪0.10`; `market_fee` default `0.00`.
Minimum sale and minimum partial refund: **500 agorot**.

### 9. ⚠️ `get-sellers` does NOT return the public key — `create-seller` is the only place it exists
Measured 2026-08-23 against `Dezabin TestA`. The response is rich — `seller_fees`,
`seller_processing_percent`, `seller_wallets`, `seller_address`, the personal and business blocks —
and there is **no key of any kind in it**: not `seller_public_key`, not the callback secret.

**So both of those are returned exactly once, by `create-seller`, and cannot be re-fetched.** If the
`seller_merchant_accounts` row loses them, that seller can never take a card again (no public key to
initialise Hosted Fields) and his callbacks can never be verified (no secret) — and the only repair
is opening a SECOND merchant account for him, which costs ₪65 a month forever and cannot be undone,
because the sandbox and the live API both lack a delete. Treat those two columns as unrecoverable.

The same call also confirmed the approval fields' real types, which the callback route parses:
`seller_approved` and `seller_active` come back as JSON **booleans** (`false` / `true`), not as the
string `'1'` their older spec shows elsewhere. `getSellerStatus` accepts both.

### 10. Hosted Fields — their published example is READABLE, unlike the guides
`github.com/PayMeService/payme-jsapi` (read 2026-08-23). This is worth stating plainly because an
earlier session concluded the browser half could not be written without talking to PayMe: that was
true of `payme.stoplight.io`, and false of the example repository, which is plain files.

    <script src="https://cdn.payme.io/hf/v1/hostedfields.js"></script>
    PayMe.create(apiKey, { testMode, language, tokenIsPermanent })   // tokenIsPermanent defaults TRUE
      → instance.hostedFields().create(PayMe.fields.NUMBER|EXPIRATION|CVC).mount('#id')
      → instance.tokenize(saleData) → { token, card: { cardMask, … } }

`token` maps to `buyer_key` on `generate-sale`. Their example's `apiKey` is a plain UUID, **not** an
`MPL…`-shaped `seller_payme_id` — so it is the `seller_public_key` from `create-seller`, and the
older note in `GO_LIVE` §3.1 saying the SDK takes the seller id describes a previous example.

**⚠️ Still not measured, and it cannot be from here:** none of this has been run in a browser. Doing
so needs a merchant that is APPROVED and whose public key we hold, and we have neither — our two
test sellers are `seller_approved: false` and their public keys were never captured (see 9 above).
Creating a third to get one is exactly what this file's warning forbids. So the remaining unknowns
are: whether the public key is really the right argument, and which origin serves the field iframes
(`lib/csp.ts` declares all three PayMe hosts rather than guessing narrow).

### 11. ⚠️ `market_fee_fixed` is the real field. `direct_market_fee` is silently IGNORED
PayMe told the owner in writing that a fixed cut is available and called it **"direct market fee"**
(*"אתה יכול להשתמש ב-direct market fee או ב-market fee, הראשון זה עמלה קבועה לדוגמה ״5 שקלים״,
השני זה אחוז מתוך העסקה"*). That is their conversational name, not the API's. Measured 2026-08-23,
two paid sandbox sales of ₪50 each, same token, fee read back with `get-sales`:

| sent | `sale_market_fee_fixed` | `sale_market_fee_total` |
|---|---|---|
| `market_fee_fixed: 15` | `15` | `1500` ✅ |
| `direct_market_fee: 15` | `0` | `0` ❌ |

**⚠️ The generalisable danger is the SILENCE, not the name.** PayMe accept unknown parameters without
any complaint, so a misspelled fee field is not an error — it is a sale on which we take nothing,
discovered a month later when the distribution fee is short. **Never change a fee field name from a
document. Change it only against a paid sale whose fee you read back.**

Also confirmed on the same pair: `market_fee: 0` really is honoured (`sale_market_fee: "0.00"`), so
sending an explicit zero is meaningful and must not be dropped as falsy — which is what the shipping
leg on our own account depends on.

### 12. ⚠️ `get-sales` IGNORES its `payme_sale_id` filter — and its id field is spelled differently
Measured 2026-08-23, and it is two traps in one call.

**The filter does nothing.** `get-sales` with `payme_sale_id` returned the whole list regardless —
26 items, then 27 as more sales were made. Given no `seller_payme_id` either, that list is not even
scoped to us: **it contains other partners' sales**, because the sandbox is shared. Anything reading
`items[0]` from this endpoint is reading a stranger's transaction. (`get-sellers`, probed the same
day, DID filter correctly — so the two endpoints do not behave alike and neither may be assumed to.)

**The id is `sale_payme_id` here and `payme_sale_id` on `generate-sale`.** The same value, two
spellings, two endpoints. Matching on the wrong one returns `undefined` for every row, which is how
the first attempt at the fee measurement above silently "found no match" while looking straight at
the answer.

The defence is in `payment-payme.ts#getSellerStatus`: match the row by id in code, never index into
`items`. It was written as a precaution and turned out to be a live bug class.

### 13. `capture-buyer-token` wants `credit_card_exp` as ONE field, `MMYY`
Not `credit_card_exp_month` + `credit_card_exp_year`, which is what our adapter sent until
2026-08-23. Refused loudly — `Required parameter is missing · credit_card_exp` — which is the good
kind of failure, and the only reason it cost minutes. Testing path only; production enters the card
in Hosted Fields and sends no card fields at all.

### 14. ✅ MULTI-CAPTURE WORKS — and the session that said otherwise called the wrong endpoint
Measured 2026-08-23. `§3.1.1` item 4 concluded multi-capture was "not enabled on our key" after
authorizing ₪100, capturing ₪40 and being refused a second capture. **That measurement used
`capture-sale`, which is the single-capture endpoint.** PayMe's own guide documents a different call:
`generate-sale` with `sale_type: "multi-capture"` and `origin_sale_id`.

Walked properly, it works, including the thing it exists for — *"at least 2 users from the same
marketplace"*:

| step | result |
|---|---|
| `generate-sale` `sale_type: authorize`, ₪100, buyer token | `authorized` |
| `generate-sale` `sale_type: multi-capture`, ₪40 → seller **A** | `completed` |
| `generate-sale` `sale_type: multi-capture`, ₪60 → seller **B** | `completed` |
| a further ₪10 | refused `352 · סכום העסקה חורג מהמגבלות` |
| ₪30 then ₪70 of a ₪100 authorization | both `completed`; ₪1 more refused `352` |
| `refund-sale` on an uncaptured authorization | `voided` — an abandoned checkout is releasable |

**The ceiling on TOTAL captured is 100% of the authorization**, and that is the setting PayMe offered
to raise to 110%. The 60% market-fee cap is separate and still applies here — a ₪50 capture with a
₪36 cut was refused `308 · Market fee exceed allowed maximum of 60%`.

### 15. ⚠️⚠️ OUR PARTNER ACCOUNT CANNOT RECEIVE MONEY — `174`, and it breaks a shipped design
`PAYME_SELLER_API_ID` is the partner/API identity, **not a merchant**. Charging it anything is
refused:

    generate-sale → seller_payme_id = PAYME_SELLER_API_ID
    → 174 · אפשרות זו אינה נתמכת במשתמשים מסוג זה

Measured both ways — as a multi-capture leg and as an ordinary token sale — and refused identically.
The same call to a real seller account completes, which is the control.

**This invalidates the shipping design in `lib/payment-split.ts`.** It charges delivery as its own
sale "on OUR merchant account", and there is no such account: the note it was built on said a ₪30
sale "under a second account" completed, and that second account was a SELLER, never ours. Nobody
checked, because the built code was only ever exercised against a mock.

**And it makes PayMe right about the 110%, which two sessions argued about and both got wrong.** With
no account of our own to charge, the delivery fee has to ride on the seller's sale as
`market_fee_fixed` — and then a cheap item breaches the 60% cap exactly as they said (₪10 goods +
₪30 delivery ≈ 87%). Their answer 3 was correct and complete; the disagreement was ours.

**Two ways out, and the first needs nothing from them:**
1. **Give ourselves a real merchant account** via `create-seller`, like any seller, and charge
   delivery to that. Capturing to a different seller is measured working (item 14). No ceiling
   involved, money arrives as an ordinary sale.
2. Ask PayMe to raise the market-fee ceiling and fold delivery into the seller's capture.

---

## Still unmeasured — do not guess these

- The exact per-transaction fee actually deducted from a seller's balance (the tariff was READ, not
  measured against a balance).
- Multi-capture behaviour once PayMe enable it.
- Whether the platform can switch on a seller's invoicing module through the API, or whether the
  seller must do it in their own panel. This decides how the invoicing add-on is sold
  (memory `project_business_model_pricing`).
- The callback: nothing has been received end to end, because that needs a public URL.
