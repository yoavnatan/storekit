# PayMe — what was measured, and how to measure it again

**Everything here was produced by real calls against `https://sandbox.payme.io/api/` on 2026-08-21.**
Nothing in this file is recalled, inferred from a marketing page, or carried over from an earlier
session. Where something is *not* measured it says so.

This file exists because the same wrong turn was taken twice: PayMe's guide pages
(`payme.stoplight.io/docs/guides/…`) are a JavaScript application that returns a title and no body
to any FETCH, so a session that needs a fact reaches for the readable spec instead — and the
readable spec is **old**. ⚠️ **That sentence became an excuse, and it is only half true: a headless
browser renders them fine.** They are captured in `docs/payme-docs/` since 2026-08-23 (§17), and
four of this file's corrections came out of them. Read those before trusting the raw spec for
anything. It does not know `pay-sale`, `update-seller`, `market_fee_fixed` or
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

### 4. ❌ SUPERSEDED BY §14 — "multiple captures are not enabled on our key" was WRONG
**Read §14 instead. Multi-capture works, and the entire split model rests on it.** This measurement
called `capture-sale`, which is by definition the single-capture endpoint; the multi-capture call is
`generate-sale` with `sale_type: "multi-capture"` and `origin_sale_id`. The paragraph is kept
verbatim below rather than deleted, because its conclusion was quoted into GO_LIVE and into a design
decision — someone who remembers reading it needs to find it and see that it fell.

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

**⚠️ READ THE TABLE BELOW BEFORE ANY SENTENCE IN THIS SECTION.** Three sessions have now confused
these two numbers, this file has stated it both ways round on the same day, and the only thing that
settled it was measuring each one and writing down its error code.

| | limits | value | error | measured 2026-08-23 |
|---|---|---|---|---|
| **capture ceiling** | how much of an **authorization** may be drawn in total | **100%** | `352` | authorize ₪100 → capture ₪30 ✅ then ₪70 ✅ then ₪1 ❌ |
| **market-fee ceiling** | how much of a **sale** may be **our cut** (`market_fee` % + `market_fee_fixed`) | **60%** | `308` | capture ₪50 with a ₪36 cut (72%) ❌ |

**They are not the same question.** The first is about the BUYER's money — how much of what he
approved can actually be taken. The second is about SPLITTING one sale — how much of it is ours
rather than the seller's.

**And a third measurement decides which one the delivery problem is:** a full ₪100 capture of a ₪100
authorization **carrying a ₪15 fixed fee** completed. If the fee were drawn on top of the capture,
that would have needed ₪115 of a ₪100 authorization and been refused `352`. It was not — so
**`market_fee_fixed` comes out of the seller's proceeds and consumes no authorization headroom**,
exactly as the agreement's §10.4 describes it.

Therefore: **delivery-by-fixed-fee is constrained by the 60%, never by the 100%.** ₪10 of goods with
₪30 of delivery is an 87% cut and is refused `308`.

**⚠️ And PayMe's own suggested shape does not scale — the owner found this, 2026-08-23.** Their
"110%" is the capture ceiling: authorize the goods, then capture past it to pull the delivery
through. ₪300 + ₪30 really is 110% — but ₪20 + ₪30 is **250%**, and ₪10 + ₪30 is 400%. The required
ceiling is `(goods + delivery) / goods`, which rises without bound as the item gets cheaper, so no
single setting fixes it. Authorizing goods AND delivery together and capturing 100% has no such
dependency, which is what this codebase does.

**Which leaves what PayMe offered.** Their words are *"כשעושה **לכידה** בשווי 500 ש״ח שהם **100%**…
להעלות ל-110%"* — capture language and the capture number, i.e. the FIRST row. ⚠️ That reading is an
inference from their wording and not a measurement, and it matters: **if it is right, the 110% they
offered does not unblock delivery, and the ceiling that has to move is the 60%.** Ask them which one
they meant rather than accepting the offer as given.

---

**The exchange itself, 2026-08-23, produced by the owner:**

The owner asked them, verbatim:

> *"האם בפיצול ניתן להגדיר גם סכום דינמי שלא מחושב באחוזים מהעסקה? (למשל — דמי משלוח שהקונה משלם
> ואני צריך שיעברו אליי כדי שאשלם לחברת המשלוחים)?"*

PayMe answered:

> *"כן. זה אומר שכשאתה עושה לכידה בשווי 500 ש״ח שהם 100%, אני צריך להעלות לך את האפשרות בהגדרות
> אצלי ל‑110% לדוגמה."*

**What is CERTAIN from the exchange**, and it is worth separating from what is not:
* A fixed cut exists and is supported. (Their API name for it is `market_fee_fixed` — §11.)
* **A ceiling has to be raised for the delivery case, and it is a per-account setting they control.**
  That is the operative fact and it does not depend on which ceiling they meant.

**What is NOT certain: which of the two ceilings.** Their sentence says *לכידה* and *100%*, which is
the capture ceiling's vocabulary and its number. But the measurement above shows a fixed fee consumes
no authorization headroom, so raising the capture ceiling would not unblock delivery — the 60% would.
Either they meant the 60% and described it loosely, or they meant the 100% and the offer does not
address the problem.

**Do not resolve this by argument. Two sessions tried and produced opposite answers on the same day,
both stated confidently, both written into this file.** Ask them plainly: *"the ceiling that blocks
us is the 60% cap on `market_fee` + `market_fee_fixed` — error 308 — is that the one you are
raising?"*

**And it may not need asking at all.** §15: the delivery fee only has to ride on the seller's sale
because we have no merchant account of our own to charge. Opening one with `create-seller` removes
the ceiling from the picture entirely.

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

**⚠️ Before choosing between the two routes below, ask whether 174 is a SETTING.** Today's lesson is
exactly this shape: multi-capture read as "not enabled on our key" and turned out to be the wrong
endpoint plus a switch PayMe control. `174 · אפשרות זו אינה נתמכת במשתמשים מסוג זה` is the same
vocabulary — "not supported for users of this type" describes a TYPE, and a type is a setting on
their side. **If they can enable card acceptance on the partner account, both routes below become
unnecessary.** Nobody has asked.

**The owner's objection to route 1 is a fair one and worth answering rather than waving through**
(*"למה שאני אפתח חשבון בית עסק? אני השותף!"*): partner and merchant are two different roles and this
platform performs both. As PARTNER we onboard sellers and collect a distribution fee, monthly, on the
20th. As a MERCHANT we would be taking a card payment from a buyer for something we sell him
directly — delivery, which is ours: our contract with the courier, our cost to cover
(AI_INSTRUCTIONS → *Shipping is ours*). Being the partner does not exempt us from needing a merchant
account to accept a card, any more than it exempts us from having a company. It costs ₪65/month plus
a ₪99 setup, per appendix ב׳.

**The two routes, if 174 turns out not to be a setting:**
1. **Give ourselves a real merchant account** via `create-seller`, like any seller, and charge
   delivery to that. Capturing to a different seller is measured working (item 14). No ceiling
   involved, and the money arrives as an ordinary sale rather than as a monthly fee.
2. Ask PayMe to raise the **60%** market-fee ceiling (see §6 — NOT the 100% they offered) and fold
   delivery into the seller's capture as `market_fee_fixed`.

### 16. Subscriptions — PayMe's own recurring billing, and it fills a hole GO_LIVE calls homeless
From their guide's state chart (owner, 2026-08-23). Not part of the checkout; this is how the
SELLER's monthly fee gets collected.

    generate-subscription → sub-create
      first payment ok      → sub-active → (wait for iteration date) → charge
      first payment fails   → sub-failure
      iteration ok          → sub-iteration-success + sale-complete → last one? → sub-complete
      iteration fails       → retry THE FOLLOWING DAY … 7th failure → sub-canceled
      manual cancellation   → sub-canceled

**Why it matters beyond convenience:** `GO_LIVE` §3.0.1 records that what a seller owes US —
subscription, ads, return shipping — has *no collection path*, because under the split model there
is no balance of his we can deduct from. For the subscription part, this IS the collection path: a
card on file, charged monthly, with dunning (7 daily retries) and cancellation handled at their end
rather than by a job of ours. Appendix ב׳ prices it at **ללא עלות**.

It also fits the billing rule `lib/pricing.ts` already states — the fee starts at the seller's FIRST
SALE, capped at 2 months from signup — because the subscription is created when we choose, not at
registration.

⚠️ Unbuilt, and deliberately: `generate-subscription`, `cancel-subscription` and `get-subscriptions`
exist on the account (endpoint discovery, §"What exists") but none has been called. Nothing here is
measured.

### 17. Their documentation IS readable — with a browser. Four corrections came straight out of it
`docs/payme-docs/` holds 133 rendered pages, captured 2026-08-23 with Playwright after every
non-browser route failed (no sitemap; a crawler user-agent gets `403`; their content API resolves
the route but wants an internal node id). **The header of this file has said since 2026-08-21 that
their guides "return a title and no body to any fetch", and that was true and became an excuse.**
Three sessions designed against the old raw spec instead. What the pages then corrected:

* **`seller_inc` — two of our three values were wrong.** Their Israeli list is
  `1 פרטי · 2 עוסק מורשה · 3 חברה בע"מ · 4 שותפות · 5 עוסק פטור · 6 עמותה`. We were sending `2` for a
  limited company (that is עוסק מורשה) and `1` for an עוסק מורשה — and `1` is a PRIVATE INDIVIDUAL,
  the category the platform contractually excludes, which was also the fallback for anything
  unmapped. Fixed in `merchant-kyc.ts#paymeIncorporation`, which now returns null rather than guess.
* **The merchant category is not an ISO 18245 MCC.** Theirs is a private numbering from 10000 up,
  enumerated by trade (`10009 מאפיה`, `10200 הלבשה כללית`). Our `5999` fallback is not in their list
  at all. There is no cross-trade generic row, so there is no safe default and the field is now
  simply required.
* **An authorization is held for up to 168 hours**, and capturing after that fails. Not a constraint
  the checkout hits — it captures immediately — but it bounds anything that ever defers a capture.
* **`market_fee` is documented `>= 0, <= 60`** in their own API reference, which agrees with the
  `308` refusal measured here. One of the few places a page and a measurement can be checked
  against each other, and they match.

⚠️ **What is still NOT there: the callback signature formula.** Their callbacks page lists
`payme_signature` as an attribute and links to an "MD5 Signature" page that the crawl did not
capture. So `verifyCallbackSignature` still rests on the OLD raw spec, and remains the one part of
the adapter with no confirmation from either a measurement or a current page.

⚠️ **And a name that will mislead the next reader: "Generate Multi Checkout Payment" is not
multi-seller.** It is one payment page offering several payment METHODS (card, bit, Apple Pay,
Google Pay). Multi-capture is the multi-seller mechanism.

### 18. ✅ DELIVERY HAS A HOME: a merchant account of OUR OWN, and the 60% ceiling stops mattering
Measured 2026-08-23, and it closes the argument that ran through this whole file.

The partner identity cannot receive money (§15, `174`). That is what forced delivery to ride inside
each seller's capture as `market_fee_fixed`, and THAT is what made the 60% cap bite on cheap items —
₪10 of goods with ₪30 of delivery is an 87% cut. Which in turn made us dependent on PayMe raising a
ceiling, which the owner cannot request: their sandbox was sent for evaluation, and changes need a
signed agreement.

**None of that is necessary.** The partner cannot receive money; a MERCHANT can — and we can open one
for ourselves with `create-seller`, using nothing but the API we already have:

    create-seller  "Dezabin Delivery"        → MPL17874-990088XH-20DMI0AE-UPSUETVB
    authorize ₪90 on the SELLER              → authorized
    multi-capture ₪60 → the seller           → completed
    multi-capture ₪30 → OUR OWN merchant     → completed

So a cart is one authorization and N+1 captures: one per store, plus delivery to us. Our cut on a
seller's capture is then just the tier commission — 10–12%, nowhere near 60% — and the ceiling is
out of the picture on every order at every price.

**⚠️ It costs ₪65/month** (appendix ב׳, per merchant account) and a ₪99 setup. That is the price of
not needing anybody's permission, and it is trivial against the alternative.

### 19. ⚠️ For an עוסק מורשה, the business number must EQUAL the owner's ת.ז
Refused on the first attempt at §18, in their own words:

    114 · עבור סוג עוסק "עוסק מורשה" מספר העסק חייב להיות זהה למספר תעודת הזהות של בעל העסק

**This will reject a real seller of ours**, because `payout-details.ts` collects `businessId` and
`merchant-kyc.ts` collects `ownerSocialId` as two independent fields, and nothing compares them. An
עוסק מורשה who types his ת.ז in one and his ע.מ number in the other — which is what the labels invite
— is refused at `create-seller` with a message he never sees, and his store silently cannot sell.
`seller_inc` 2 is the commonest kind of seller this platform will have.

### 20. `seller_public_key` really is an object, and `seller_approved` is ABSENT on create
Both confirmed by the real `create-seller` response in §18: the key came back as
`{ uuid, description, is_active }`, and `seller_approved` was **undefined** rather than `false`.
`createSeller` already reads the object shape and already treats an absent flag as not-approved —
both were written from their documentation before this call proved them.

### 21. ✅ THE CARD FIELDS RENDER — and the CSP was declaring the wrong hosts
Driven in a real browser 2026-08-23 (Playwright, a built server, a merchant opened through our own
`ensureMerchantAccount`). This is the one part of the purchase flow that had never run in a browser.

**Their field iframes come from `https://hf.payme.io`.** `lib/csp.ts` declared `cdn.payme.io`,
`sandbox.payme.io` and `live.payme.io` — the loader and both API hosts — and **none of them is it**:

    Framing 'https://hf.payme.io/' violates the following Content Security Policy directive:
    "frame-src 'self' … https://cdn.payme.io https://sandbox.payme.io https://live.payme.io"

Three empty rectangles, no card entry, one console line. The old comment in `csp.ts` said the field
origin was unmeasured and that declaring all three API hosts covered it "because guessing too narrow
fails silently and awfully" — the reasoning was right and the answer was still wrong, which is the
whole argument for driving it rather than reading about it. Fixed; the four frames that mount are
`/service/primary`, `/service/field/cardNumber`, `/service/field/cardExpiration`, `/service/field/cvc`.

**`seller_public_key` is the right argument.** It arrives as a plain UUID and appears verbatim as the
`t=` parameter on every field iframe. The older note in GO_LIVE §3.1 saying the SDK takes the
`seller_payme_id` was describing their previous example.

**And a merchant has to be created through OUR code to be usable at all.** Not because of approval —
sandbox skips that deliberately — but because `create-seller` returns `seller_public_key` exactly
once. The two test merchants were created by hand with curl, so neither can ever draw a card field.
A fourth was opened through `ensureMerchantAccount` and all three unrecoverable columns were stored.

⚠️ Still not driven: typing a real card and `tokenize()` end to end in the browser. The server half
of that path is measured (`payme-probe.mjs flow`).

### 22. ⚠️ They enforce the ת.ז check digit and we deliberately do not
`create-seller` refused `999999999` with `101 · ת.ז לא תקינה`. `merchant-kyc.ts` validates the SHAPE
only (nine digits) and its header argues why — a false rejection is unrecoverable from the seller's
side. Both positions are defensible and together they produce a bad outcome: a seller who mistypes
his ת.ז gets a store that silently cannot sell, and the only trace is a line in our error log. He is
shown "details are missing", which is true and unhelpful. Worth surfacing PayMe's own message.

---

### 23. ✅ A PLAN CHANGE IS A PATCH, not a cancel and a new subscription

**`PATCH {base}subscriptions/{sub_payme_id}/set-price`** — the one endpoint on this integration that
is not a POST to `{base}{name}`, and the id is in the PATH. Body: `seller_payme_id` and `sub_price`
**as a string, in agorot** (their documented minimum is 500). Measured 2026-08-24 with
`scripts/payme-probe.mjs subscription`:

| what was done | answer |
|---|---|
| live token subscription created at `9900` | `sub_status: 2`, `sub_paid: true` |
| patched to `12500` | `status_code: 0`, response echoes `sub_price: "12500"`, `sub_status` still 2 |
| patched again to `17900` | `status_code: 0` |
| `get-subscriptions` afterwards | `sub_price: 17900` · `sub_next_date` unchanged |

So the standing order keeps its card, its id and its schedule, and only the amount moves — which is
what a seller changing plan mid-subscription needs, and it is what `lib/seller-subscription.ts`
does. **Cancel-and-recreate is the wrong shape here**: it discards a card the seller already
authorised and asks him to enter it again for a one-click change.

**`payme_client_key` is NOT required by this endpoint.** The probe ran it both with and without, and
both were accepted — `seller_payme_id` alone was enough. We send the key anyway, because every other
call on this client does and one call authenticating differently is a fact about PayMe rather than a
licence to treat it as special. Worth remembering if their auth ever tightens.

**It only works on an ACTIVE subscription, and that is the second finding**
(`payme-probe.mjs set-price`, 2026-08-24):

| subscription | `set-price` | what we do instead |
|---|---|---|
| `active` (2) — paid, billing | ✅ accepted, price replaced | patch it |
| `initial` (1) — created, unpaid | ❌ *"עדכון מנוי נכשל"* | cancel it (measured: accepted) and let the next attempt create one at the new price — no card was charged and there is no standing order to preserve |

**And the timing, which is the question a seller actually asks** (owner: *"אבל זה נכנס לתוקף ממש
מידי? מה יהיה בחיוב הקרוב?"*): **the patch itself charges nothing.** It returns no sale and no
`payme_sale_id`, `sub_iterations_completed` does not move, and `sub_next_date` stays where it was —
only `sub_price` changes. A subscription carries ONE price, so the next scheduled iteration takes
the new one, and the charge already collected is untouched.

**What could NOT be observed, and is therefore still not claimed as measured:** an actual monthly
iteration firing after a patch. Forcing one is not available — `pay-subscription` on an already-paid
subscription is refused with `305` (*"סטטוס מכירה לא מתאים"*), and a real iteration is a month away.
The seller is told "from the next charge", which is what the price field and the untouched
`sub_next_date` support.

### 24. ✅ OUR OWN MERCHANT, RE-OPENED — this time keeping what it hands back
The §18 account works and its keys were never stored, which cost the one thing the key is for: with
no `seller_public_key` we cannot draw Hosted Fields on our own account, so a SELLER's card cannot be
typed on our page and the subscription has to hand him to PayMe's payment page. That handoff is a
week-long gap between a seller deciding and a seller paying — the owner named it exactly
(2026-08-24) — and closing it means holding his CARD from the moment he decides.

So a second one was opened, 2026-08-24, through `scripts/payme-open-own-merchant.mjs`, whose whole
purpose is printing the three values that come back once:

    MPL17875-81054MRK-DPR36FXB-UT2ALXWW      → PAYME_DELIVERY_MERCHANT_ID
    0d0d7b34-a538-48d2-bbce-f4e5b4fdd4ad     → PAYME_OWN_PUBLIC_KEY
    (callback secret + signup link printed alongside; nothing reads them for our own account yet)

Re-measured immediately: `payme-probe.mjs flow` captures the ₪30 delivery leg into it, so it is a
working merchant and not merely a row. `seller_inc: 3` (חברה בע"מ) rather than 2, which would carry
§19's rule that the business number must equal the owner's ת.ז.

⚠️ **The old account is abandoned, not deleted** — there is no delete. It costs ₪65/month in
production, which is exactly why the production account is opened once, by a person, and why the
script dry-runs by default and refuses any base URL but the sandbox.

### 25. ✅ THE SELLER'S OWN BALANCE IS READABLE — `get-future-withdrawals` / `get-withdrawals`
Measured 2026-08-25 against `Dezabin TestA`, for `CURRENT_TASK` סשן א׳ §1 (*"איפה המוכר בעצם רואה
כמה כסף יועבר לו"*). Both endpoints exist, answer with the partner key alone, and need nothing from
the seller.

`get-future-withdrawals` requires `seller_payme_id` **and `currency`** (it names `currency` first,
which is how you know it is required). Real answer, seven rows: six DATED daily windows all holding
`total: 0`, and one row with `end_time: -1` holding `"101348"` — ₪1,013.48. So the shape is: money
accrues into an OPEN window with no payment date, and PayMe date it when they close it. A screen
that promises a date from this data would be inventing one; `lib/seller-transfers.ts` is written to
that shape and `payTransferNextUnknown` is the sentence it prints instead.

⚠️ **Two unit traps in one pair of endpoints.** `total` (future) comes back as a STRING on a row with
money and as the NUMBER `0` on an empty one; `withdrawal_total` (past) is a number. Both are AGOROT.
`payment-payme.ts#withdrawalAgorot` converts once, at the edge.

`get-withdrawals` answered `items_count: 0` for the same seller — nothing has ever been paid out of
the sandbox — so the PAST shape is documented and not measured. What was measured is that it exists,
accepts the paging arguments, and does not error.

`withdraw-balance` also exists and is deliberately **not** wired: the payment schedule is PayMe's
(agreement §37), and a manual withdrawal costs the seller ₪14.9 in a month under ₪5,000 of
withdrawals. A button that spends his money over a fee he did not read is the opposite of the screen
it would sit on.

### 26. ⚠️ WE CANNOT SWITCH ON A SELLER'S INVOICING MODULE — this closes an open question
Measured 2026-08-25, for `CURRENT_TASK` סשן א׳ §2 (*"גם פה יש אפשרות שלא יצטרך לצאת לפיימי?"*).

`get-vas-seller` lists what is provisioned on a merchant. `Dezabin TestA` came back with **19
services and not one of them is `Invoice` or `InvoicingService`** — the list is `Settlements`,
`AlternativePaymentMethod`, `Payments`, `Email`, and 3DSecure sitting there `vas_is_active: false`.
And `vas-enable` requires a `vas_payme_id`: it ACTIVATES a service that already exists on that
seller, and there is no endpoint anywhere that creates one. So the platform cannot turn invoicing on
for a seller through the API — PayMe have to provision it, which makes it a commercial step and not
an integration one.

**What the answer therefore is, today:** the seller issues the buyer's invoice from his own system
and marks it provided on the order card (`lib/invoicing/buyer-invoice.ts`), and nobody has to open
PayMe for that. If the module IS provisioned, PayMe issue it automatically in his name and hand back
`sale_invoice_url` on the sale callback and on `refund-sale`'s own response, with `sale_invoices` on
`get-sales` — i.e. the automatic path is a PULL we could add without the callback, on the day a
seller actually has the module. Not built, because until one does the code would be unreachable and
untestable. The price is on the seller either way (₪15/month + ₪0.3/document, GO_LIVE §3.1.0).

## Still unmeasured — do not guess these

- The exact per-transaction fee actually deducted from a seller's balance (the tariff was READ, not
  measured against a balance).
- ~~Multi-capture behaviour once PayMe enable it.~~ **Measured — §14.** It was never disabled; §4
  called the wrong endpoint. What remains unmeasured about it is only the raise PayMe offered, from
  a 100% to a 110% capture ceiling, which nothing we have built needs.
- ~~Whether the platform can switch on a seller's invoicing module through the API.~~ **Measured —
  §26. We cannot: `vas-enable` activates a service that already exists on the seller, and no
  Invoice VAS is provisioned on one we created.** What is still unmeasured is the shape PayMe hand
  back once a seller really has it — `sale_invoice_url` is documented and has never been seen.
- The PAST-withdrawal shape (§25): the endpoint answers, and the sandbox has never paid anybody, so
  the fields are read from their documentation rather than from a row.
- The callback: nothing has been received end to end, because that needs a public URL.
- Whether `set-price` on a subscription that is mid-cycle moves the current iteration or only the
  next (§23).
