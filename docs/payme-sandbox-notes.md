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

**⚠️ There are TWO different ceilings here and a previous note ran them together. Corrected
2026-08-23, after the owner asked why he had only ever heard about 100% and 110%.**

They are not the same setting and they are not about the same thing:

| | what it limits | value | how we know |
|---|---|---|---|
| **Capture ceiling** | how much of an AUTHORIZATION may be captured | 100% | measured — ₪11 against a ₪10 authorization was refused, `352 · Invalid price, out of min-max bounds` (item 4 above) |
| **`market_fee` ceiling** | how much of a SALE may be OUR cut | 60% | measured — `Market fee exceed allowed maximum of 60%`, a refusal in their own words |

**What PayMe's representative discussed — 100%, and raising it "to 110% for example" — was the
CAPTURE ceiling**, i.e. capturing slightly more than was authorized. That is a normal thing for a
gateway to offer (a tip, a weight-based delivery adjustment) and it has nothing to do with our
commission. He never mentioned 60%.

**The 60% is not something anybody told us. It is an error string the API returned**, so it is true
whether or not it was ever discussed — and it is the one that shapes the design. An earlier session
guessed the two were one setting and wrote that his "110%" offer applied to the market fee. That
guess was flagged as a reading at the time and is now recorded as almost certainly WRONG: raising a
capture ceiling would not move a market-fee cap.

**Consequence, and it is the useful part: asking to raise the 60% is a NEW request, not the
acceptance of an offer already made.** It is also not urgent — the design above sidesteps the cap
entirely by charging delivery on our own account, and nothing depends on the answer.

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

---

## Still unmeasured — do not guess these

- The exact per-transaction fee actually deducted from a seller's balance (the tariff was READ, not
  measured against a balance).
- Multi-capture behaviour once PayMe enable it.
- Whether the platform can switch on a seller's invoicing module through the API, or whether the
  seller must do it in their own panel. This decides how the invoicing add-on is sold
  (memory `project_business_model_pricing`).
- The callback: nothing has been received end to end, because that needs a public URL.
