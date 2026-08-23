-- The seller's OWN clearing account at PayMe — the row that makes the split model possible.
--
-- ── Why the platform needs this at all ──
-- Under the split model (2026-08-21) the platform never holds a shekel of a seller's money: PayMe
-- capture each store's share straight into that seller's own merchant account. That account is a
-- real business relationship between the seller and PayMe, opened through `create-seller`, and the
-- id it returns is THE WHOLE OF THE JOIN between his account here and his account there — PayMe
-- refuse our own `seller_id` correlation field on this plan (error 790, measured 2026-08-21). Lose
-- this row and there is nothing on their side pointing back at us.
--
-- ── Why it is a table and not four columns on `sellers` ──
-- `payme_seller_secret` is a SECRET — it is half of the MD5 that proves a payment callback really
-- came from PayMe (`lib/payment-payme.ts#verifyCallbackSignature`). `seller-auth.ts#toSeller`
-- builds the object every dashboard template renders, and a secret that lives on it is one
-- `JSON.stringify(seller)` away from a page. Its own table has its own reads, and the secret is
-- fetched by exactly one function.
--
-- ── PER SELLER, not per store, and that is an economic fact and not a schema preference ──
-- PayMe bill us ₪65 a month per merchant account (agreement, appendix ב׳ — verified with them),
-- against a ₪99 base subscription per SELLER ACCOUNT (`lib/pricing.ts` — the subscription is per
-- registered business, never per store). One account per store would make a seller with three
-- stores cost ₪195 a month against one ₪99 subscription, i.e. every multi-store seller would be
-- sold at a loss. Hence the primary key: one row per seller, shared by all his stores.
--
-- ── `approved` starts FALSE, and it is not a formality ──
-- PayMe examine every business and may reject one at their sole discretion (agreement §11), and a
-- newly created merchant comes back `seller_approved: false` / `Restricted`. So "the store is open"
-- never implies "this seller can take money", and the difference has to be a value the UI can read
-- rather than an assumption — a seller who cannot be told why his checkout refuses will ask us,
-- which is the manual touch this platform is built to avoid.
--
-- Timestamp-named rather than numbered: parallel sessions cannot reserve a NUMBER between them
-- (memory `feedback_parallel_sessions`).

CREATE TABLE IF NOT EXISTS seller_merchant_accounts (
  seller_id        uuid PRIMARY KEY REFERENCES sellers(id) ON DELETE CASCADE,
  -- Named rather than assumed. `lib/payment.ts` has been through three providers on paper already;
  -- a row that does not say whose account it is becomes unreadable the day a second one exists.
  provider         text    NOT NULL DEFAULT 'payme',
  -- Their merchant id. UNIQUE because two sellers pointing at one merchant account would route one
  -- seller's money into the other's bank account, and there is no louder failure in this schema.
  provider_ref     text    NOT NULL,
  -- The per-seller callback signing key. A secret — see the header.
  callback_secret  text    NOT NULL DEFAULT '',
  -- Hosted Fields public key. Not a secret; it is meant to reach the browser.
  public_key       text    NOT NULL DEFAULT '',
  -- Where the seller finishes his own KYC. Handing him this link is what keeps the details PayMe
  -- require (birth date, ID issue date, bank account) off our own registration form
  -- (memory `feedback_seller_form_burden`).
  signup_link      text    NOT NULL DEFAULT '',
  approved         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_merchant_accounts_provider_ref_unique UNIQUE (provider, provider_ref)
);

-- ── The details PayMe require to open that account, which we do not otherwise hold ──
--
-- `create-seller` demands the account owner's ת.ז, birth date, ID issue date, gender, mobile, the
-- business's registration date and MCC, and the business address. None of it is asked for at
-- registration or at store opening (memory `feedback_seller_form_burden`): a seller uploads a
-- catalogue and opens a shop without meeting any of it, and only a seller who wants to take money
-- is asked. The bank block already on the store-opening card (`payout-details.ts`, optional there
-- and staying optional) covers three more of PayMe's required fields, so it is not repeated here.
--
-- **One JSONB column, not ten.** Nothing queries inside it — it is read once, whole, by the one
-- function that builds a `create-seller` call (`lib/merchant-kyc.ts`), exactly like
-- `payment_intents.snapshot`. Ten typed columns would be ten migrations' worth of commitment to a
-- form whose final shape is the owner's to decide, and would buy nothing: there is no report, no
-- sort and no filter over any of these values, only a single all-or-nothing read.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS merchant_kyc jsonb;
