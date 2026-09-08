-- The seller's OWN clearing account — the SaaS shape, where the platform never touches his money.
--
-- ── Why a second table beside `seller_merchant_accounts` ──
-- That table describes an account WE opened for him at PayMe under the split model: it holds a
-- provider_ref we minted, a callback secret that came back exactly once, and an `approved` flag
-- PayMe control. This table describes the opposite arrangement — an account the seller already had,
-- whose credentials he pastes in, which we never created and cannot re-issue. Merging the two would
-- put two different owners of the same row in one place, and the `⚠️ cannot be recovered` warning on
-- the PayMe columns would silently start applying to values a seller can simply paste again.
--
-- Both models exist in the tree on purpose. The split is built and measured (`payment-payme.ts`)
-- and is switched on the day PayMe's 8,000₪ is worth paying; until then it is the seller's own
-- account that takes the money. `docs/pivot-saas.md` explains the decision.
--
-- ── One row per SELLER, not per store ──
-- Same reasoning as `seller_merchant_accounts`: a seller's business relationship with his clearing
-- provider is one relationship, whatever number of shops he opens on top of it.
--
-- ── `credentials` is one sealed string, and it is not searchable on purpose ──
-- Every provider asks for a different set of values (Hyp: masof + key + password; PayPlus: page uid
-- + api-key + secret-key), so typed columns would mean a migration per provider. It is read whole,
-- by one function, exactly like `payment_intents.snapshot`. It arrives already encrypted from
-- `lib/secret-box.ts` — AES-256-GCM, keyed from SECRET_BOX_KEY — so a leaked backup is not a
-- leaked terminal. NOTHING may write plaintext here; `tests/seller-own-clearing.test.ts` asserts
-- what goes in is unreadable without the key.
--
-- Timestamp-named rather than numbered: parallel sessions cannot reserve a NUMBER between them
-- (memory `feedback_parallel_sessions`).

CREATE TABLE IF NOT EXISTS seller_clearing_credentials (
  seller_id   uuid PRIMARY KEY REFERENCES sellers(id) ON DELETE CASCADE,
  -- An id from `lib/clearing-providers.ts`. Text rather than an enum: adding a provider is meant to
  -- be a registry entry plus an adapter, never a migration.
  provider    text NOT NULL,
  -- The sealed JSON object of that provider's fields. Empty string means "chosen a provider, has
  -- not finished pasting" — a real state, and the settings screen reports it back to him.
  credentials text NOT NULL DEFAULT '',
  -- When the credentials last proved they work against the provider. NULL means never tested, which
  -- is what the shop's checkout must treat as "not connected yet" — a seller who pasted a typo has
  -- otherwise only one way to find out, and it is a real buyer failing to pay.
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
