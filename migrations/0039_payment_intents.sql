-- The checkout, held between two requests, because a hosted payment page puts a HUMAN in the middle.
--
-- `/api/checkout` was written for a gateway you can charge from the server: validate, authorize,
-- write the orders, capture, all inside one handler. No Israeli gateway that keeps this codebase
-- out of PCI scope works that way — the buyer authorizes on the provider's own page (embedded in
-- an iframe here, by the owner's decision on 2026-08-17), and our server learns the outcome from
-- the redirect that brings them back. So the one handler becomes two, and everything the second
-- one needs has to survive the gap.
--
-- **Why a table and not a signed cookie or a hidden field.** Everything in this row decides money:
-- what was in the cart, what each line cost, what the total came to. A copy that travels through
-- the buyer's browser is a copy the buyer can edit, and re-deriving it on return is not the same
-- thing either — prices, stock and coupons all move, so the second request would silently be
-- pricing a different cart than the one that was authorized. The row is the record of what was
-- agreed at the moment the buyer was sent to pay.
--
-- **Why it is not `checkout_claims`.** That table answers "has this attempt already completed",
-- and its whole value is that it is small, hot and written on every attempt. This one holds a
-- cart-sized snapshot for a few minutes. Different lifetime, different size, different question.
-- `checkout-idempotency.ts` still owns the key; this owns what the key was for.

CREATE TABLE IF NOT EXISTS payment_intents (
  -- Ours, and the only handle that travels to the provider and back. Random rather than sequential
  -- because it appears in a URL the buyer's browser holds: an id you can count from is an id you
  -- can enumerate.
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The idempotency key this intent belongs to, so a buyer who reloads the payment page resumes
  -- the same intent instead of reserving stock a second time. UNIQUE for exactly that reason.
  idempotency_key text NOT NULL UNIQUE,
  -- `checkoutOwner(buyerEmail)` — the same hash `checkout_claims` uses. The return leg must prove
  -- WHOSE payment it is holding: an id that arrives in a browser is an identifier and never a
  -- permission (lib/checkout-idempotency.ts#checkoutOwner argues this at length).
  owner           text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'authorized', 'settled', 'failed', 'expired')),
  -- Agorot, like every other amount in this database. The authoritative total: the return leg
  -- captures against THIS, never against a number that came back with the buyer.
  amount_agorot   bigint NOT NULL CHECK (amount_agorot > 0),
  -- The cart, the buyer's details and the per-store slices, exactly as they were priced. JSONB
  -- rather than child tables because nothing queries inside it — it is read once, whole, by the
  -- request that finishes the checkout, and then it is history.
  snapshot        jsonb NOT NULL,
  -- What the provider called this transaction. Written when the authorization comes back, so it is
  -- null for a pending intent and the thing a capture or a void is aimed at afterwards.
  provider_ref    text,
  -- Free-form, provider-shaped: Hyp's ACode/UID/token live here between authorize and capture.
  provider_data   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A buyer who opens the payment page and walks away must not hold stock forever. The sweep reads
  -- this; it is stored rather than computed so the window can differ per intent later (a slow
  -- payment method, a retried attempt) without every reader learning the rule.
  expires_at      timestamptz NOT NULL
);

-- The sweep's predicate: still pending, already past its window. Partial, so the index holds only
-- the intents that can still expire and shrinks back to nothing rather than growing with every
-- checkout the platform has ever taken.
CREATE INDEX IF NOT EXISTS payment_intents_expiry_idx
  ON payment_intents (expires_at)
  WHERE status = 'pending';

-- The return leg arrives with the intent id and has to find it fast; the PK covers that. This one
-- is for the operator's question instead — "what happened to this buyer's checkout" — and for the
-- reconciliation that compares intents against orders.
CREATE INDEX IF NOT EXISTS payment_intents_owner_idx
  ON payment_intents (owner, created_at DESC);
