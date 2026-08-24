-- The plan moves from the ACCOUNT to the STORE (owner, 2026-08-24).
--
-- ── What was wrong ──
-- `sellers.tier` was the single plan for a whole account, so a seller with three shops paid once.
-- The owner's ruling: *"כל חנות צריכה לעלות כסף בנפרד"*. A store is the unit the platform actually
-- delivers — its own storefront, its own SEO surface, its own feed rows, its own ad campaigns — so
-- it is the unit that is priced. `MAX_STORES_PER_SELLER` (5) is unchanged and is still an abuse
-- brake, not a package.
--
-- ── Why the commission moves with the fee, and not only the fee ──
-- A tier is one bargain: a higher monthly fee BUYS a lower per-sale commission (`lib/pricing.ts`).
-- Splitting it — fee per store, commission per account — would let a seller put one tiny shop on
-- Enterprise and collect the 10% rate for a large shop sitting on Starter. Every sale already
-- belongs to exactly one store, and every module that computes commission already has that store
-- in hand, so per-store is also the SIMPLER shape: it was per-seller only because a seller used to
-- have one plan.
--
-- ── The column is nullable and NULL means the default tier ──
-- Exactly the convention `sellers.tier` used (`pricing.ts#DEFAULT_TIER` / `resolveTier`), so a row
-- written before this migration, a row written by a code path that has not been taught about tiers,
-- and a deliberately unset plan all answer the same thing instead of throwing.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS tier text;

COMMENT ON COLUMN stores.tier IS
  'The plan THIS store is billed on — monthly fee + per-sale commission (lib/pricing.ts).
   NULL = DEFAULT_TIER. Superseded sellers.tier on 2026-08-24; see lib/store-plan.ts.';

-- Backfill: every existing store inherits the plan its account was on, so nobody's bill or
-- commission rate changes on the deploy itself. A seller with two shops starts paying for both at
-- his NEXT plan action, not retroactively — `syncSubscriptionPrice` is what moves the standing
-- order, and it only ever runs on a deliberate act (publish, close, change plan).
UPDATE stores s SET tier = sel.tier
  FROM sellers sel
 WHERE s.seller_id = sel.id AND s.tier IS NULL AND sel.tier IS NOT NULL;

-- ── The standing order now bills a SET of stores, not one plan ──
-- `price_agorot` stays the truth about what the card is charged; what it no longer has is a single
-- tier that explains it. So the breakdown that produced it is stored beside it — which is also the
-- answer to "why am I being charged ₪224 this month", a question the seller can now be shown on
-- his own screen instead of having to reconstruct.
ALTER TABLE seller_subscriptions ADD COLUMN IF NOT EXISTS store_fees jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN seller_subscriptions.store_fees IS
  'What price_agorot is made of: [{store_id, tier, fee_agorot}] at the time the standing order was
   last set. Display and reconciliation only — the charge is price_agorot, and PayMe hold it.';

-- `tier` described the ONE plan a subscription billed and no longer can. It is left in place
-- (never remove a column a deployed version still reads — Hard rules), loosened so the new code
-- can stop writing a figure that would be a guess, and its comment now says so.
ALTER TABLE seller_subscriptions ALTER COLUMN tier DROP NOT NULL;

COMMENT ON COLUMN seller_subscriptions.tier IS
  'LEGACY — one plan per account, superseded 2026-08-24 by per-store plans. Read nothing from it;
   store_fees is the breakdown and price_agorot is the charge.';

-- ── Cancelling takes effect at the END of the period he already paid for (owner, 2026-08-24) ──
-- `canceled_at` is when he pressed it; this is the day the thing he bought actually runs out. They
-- are not the same day and conflating them costs somebody real money in one direction or the other:
-- treating the press as the end takes back days he has paid for, and having no end date at all is
-- what the platform did until now — the shop stayed on the site for ever after the card stopped.
--
-- Filled from PayMe's `sub_next_date`, which they return as 'YYYY-MM-DD HH:MM:SS'
-- (measured 2026-08-24, `scripts/payme-probe.mjs subscription`) — the iteration that would have
-- been charged is exactly the moment the paid month ends. `lib/subscription-lapse.ts` sweeps it.
ALTER TABLE seller_subscriptions ADD COLUMN IF NOT EXISTS ends_at timestamptz;

COMMENT ON COLUMN seller_subscriptions.ends_at IS
  'Cancelled subscriptions only: the end of the period already paid for. The seller keeps
   everything until this moment; after it his stores come off the site (lib/subscription-lapse.ts).
   NULL on a running subscription.';

-- The lapse sweep asks "which cancelled subscriptions have run out" on a timer, which is a scan
-- over this column alone.
CREATE INDEX IF NOT EXISTS seller_subscriptions_ends_at_idx
  ON seller_subscriptions (ends_at) WHERE ends_at IS NOT NULL;
