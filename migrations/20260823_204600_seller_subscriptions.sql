-- The seller's monthly subscription — the ONE thing he owes us that has a way to be collected.
--
-- GO_LIVE §3.0.1 records the hole this half-closes: under the split model PayMe pay each seller
-- directly, so the platform never holds a balance of his to deduct anything from, and everything he
-- owes us (subscription, ad spend, return shipping) had no collection path at all. PayMe's own
-- recurring billing is that path for the subscription part — a card of his on file, charged monthly
-- against OUR merchant account, with the dunning (daily retries, cancelled on the seventh failure)
-- handled at their end rather than by a job of ours. Appendix ב׳ prices it at ללא עלות.
--
-- ── One row per SELLER, and why there is no history table ──
-- The subscription is per registered business, exactly like the tier it bills (`lib/pricing.ts`),
-- never per store. What actually happened month by month is not reconstructed from here either: the
-- charges are events, and events live in `money_events` where every other money fact of this
-- platform already lives and where `lib/reconcile.ts` can compare them against PayMe's own record.
-- This table holds the standing arrangement, which has exactly one current value.
--
-- ── `buyer_key` is a card token, and it is treated like a secret ──
-- It is not a card number and cannot be turned into one, but it CAN be charged: anyone holding it
-- can bill this seller's card through our merchant account. So it is excluded from the column list
-- every read in `lib/seller-subscription.ts` names, the same defence `seller_merchant_accounts`
-- applies to `callback_secret` — a value that must never reach a page is one a `SELECT *` must not
-- be able to fetch by accident.
--
-- ── Status is PayMe's own number, stored unmapped ──
-- 1 initial · 2 active · 4 failed · 5 canceled · 6 completed · 7 failed-pending-retry, from their
-- Subscriptions page and confirmed by a real `generate-subscription` (2026-08-23). ⚠️ Their Generate
-- page separately claims "0 active, 1 inactive", which is wrong — 0 is not in the real list. Storing
-- their integer rather than a word of ours means a status nobody has met is visible as itself, and
-- `payment-payme.ts#PAYME_SUB_STATUS` is the only place it is interpreted.

CREATE TABLE IF NOT EXISTS seller_subscriptions (
  seller_id     uuid PRIMARY KEY REFERENCES sellers(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'payme',
  -- PayMe's `sub_payme_id`. NULL while a subscription has been asked for and not yet created —
  -- which cannot happen today (the call is synchronous) and is allowed so that a future hosted-page
  -- flow does not need a schema change on a table that gates publication.
  provider_ref  text,
  -- The tier billed, copied at the moment of subscribing. NOT a join to the seller's current tier:
  -- PayMe hold a fixed iteration price, so an upgrade means cancelling and creating a new
  -- subscription, and this column is what makes the disagreement visible instead of silent.
  tier          text NOT NULL,
  price_agorot  integer NOT NULL,
  status        integer NOT NULL,
  -- ⚠️ The seller's card token. Never selected by any read that feeds a page — see above.
  buyer_key     text,
  started_at    timestamptz,
  -- PayMe's `sub_next_date`, stored as text because it is THEIR string in THEIR format and this
  -- column exists to be shown back to a seller and compared with their record, not to be computed
  -- from. Anything that needs a date computes it from `money_events` instead.
  next_charge   text,
  canceled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN seller_subscriptions.buyer_key IS
  'PayMe buyer token for the seller''s own card. Chargeable — treat as a secret, never SELECT it
   into anything a page renders (lib/seller-subscription.ts names its columns for this reason).';

-- The publication gate asks "which held sellers are now paying" (lib/store-publication.ts), and the
-- catch-up job asks the same question the other way round. Both are a scan over status.
CREATE INDEX IF NOT EXISTS seller_subscriptions_status_idx ON seller_subscriptions (status);
