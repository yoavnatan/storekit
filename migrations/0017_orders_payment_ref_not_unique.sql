-- `orders.payment_ref` was UNIQUE, and that constraint made every multi-store checkout fail.
--
-- The two facts it sat between were never compatible:
--   · ONE charge is made per checkout — /api/checkout charges `grandTotalAgorot` once, for the
--     whole cart, and the gateway hands back ONE transaction id.
--   · N order rows are created per checkout — one per store, deliberately, so each seller owns an
--     isolated order (`for (const [storeSlug, sub] of Object.entries(storeSubtotals))`).
-- So a two-store cart wrote that one transaction id onto two rows, and the second INSERT died on
-- `orders_payment_ref_key`. The whole checkout then rolled back, the reserved stock was restored,
-- and the buyer got a 500 — for a cart whose only sin was containing two shops. On a marketplace
-- whose entire premise is one cart across many stores, this failed the central case and passed only
-- the single-store one, which is why it survived to 2026-08-07.
--
-- **Why the fix is to drop the constraint and not to make the ref unique per order.** The ref is
-- the GATEWAY's transaction id. Minting a distinct one per store order would make the column a lie:
-- it would name a transaction that does not exist at the provider, and reconciliation — matching
-- our money against theirs — reads exactly this column. One charge is one ref, on every row it paid
-- for. That is the truth of the data, and a constraint that contradicts it is the thing that is
-- wrong.
--
-- **What the constraint was believed to protect, and what actually protects it.** The comment in
-- 0001_init.sql said a payment webhook that fires twice would fail here instead of creating a
-- second order. It would not have: the webhook (`/api/payment/confirm`, CURRENT_TASK א.2, still
-- unbuilt) does not INSERT orders — the orders already exist by the time it fires; it flips them to
-- paid, which no unique index constrains. The guard that genuinely stops a checkout being processed
-- twice is the idempotency ledger in `lib/checkout-idempotency.ts` (claim → complete/release, a
-- single `INSERT … ON CONFLICT` whose affected-row count is the verdict, correct across multiple
-- instances). It is in the request path today and it is unaffected by this change. The webhook, when
-- it lands, owes its own idempotency on top of it — this index is what lets it find, in one lookup,
-- every order that one transaction paid for, which under UNIQUE it could only ever have found one of.
--
-- Dropping a unique constraint is additive for readers and safe to run before its deploy: nothing
-- that was legal becomes illegal. The replacement is a plain (non-unique) index, so lookup by
-- payment_ref stays a single index scan.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_ref_key;

-- Partial: an unpaid/pending order has no ref, and there is no reason to index the NULLs.
CREATE INDEX IF NOT EXISTS orders_payment_ref_idx
  ON orders (payment_ref)
  WHERE payment_ref IS NOT NULL;
