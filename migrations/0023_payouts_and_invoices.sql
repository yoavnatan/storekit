-- The agent model's storage: when money is releasable, when it was actually sent, and the documents
-- that have to exist for either to be legal.
--
-- Background in one paragraph, because this migration only makes sense against it. The platform now
-- collects the buyer's payment as the SELLER'S AGENT (AI_INSTRUCTIONS → Payment architecture),
-- deducts commission at source, holds the balance, and pays it out on a schedule. That replaces the
-- sub-merchant model where the processor paid each seller directly and we stored nothing at all.
--
-- ── The rule this file follows, and it is the one worth stating ──
-- **Derive what is a function of the orders; store only what irreversibly HAPPENED.**
-- Gross, commission, hold state and releasable amount are all functions of the order rows, and
-- `seller-balance.ts` already argues at length why a `seller_balances` table would be a second home
-- for the same fact that drifts on the first cancellation. Nothing here contradicts that. What IS
-- stored below is the set of facts no query can reproduce: a bank transfer left (or did not), a
-- chargeback landed, a document was issued and has a number. Those are events in the world.
--
-- Every table here therefore carries a UNIQUE constraint that makes its writer IDEMPOTENT. That is
-- not defensive habit, it is the whole safety argument: a payout run, a webhook and an invoice call
-- are all things that get retried, and "retried" must mean "same row", never "second payment" or
-- "second tax document".

-- ============================================================================
-- ORDERS — the two instants the hold clock needs
-- ============================================================================

-- When the money was really taken. `created_at` is close but it is NOT the same instant: the order
-- row is written between authorize and capture (checkout.ts step 2 of 3), and an order whose
-- capture failed and was later retried has a created_at that never corresponded to money moving.
-- The hold clock must run from the money, so it gets its own column.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at timestamptz;

-- When the seller marked it delivered — stamped on the FIRST transition to 'delivered' and never
-- cleared, not even if the status moves away again.
--
-- Why "first, and never cleared": the alternative is reading `updated_at`, which is what existed,
-- and it answers a different question — the last time ANY field changed. A seller fixing a tracking
-- number three weeks later would have pushed the payout out by three weeks, silently, with no way
-- for them to see why. And a status that moves delivered → shipped → delivered (a correction, or a
-- misclick) must not restart a hold the buyer's return window already ran through.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- The payout run scans "paid orders whose hold has expired". Both columns are in the predicate and
-- neither is selective on its own, so the index carries them together. Partial on paid_at because
-- an order that was never captured can never be paid out, and that is most of what a busy table
-- accumulates over time (failed captures, abandoned attempts).
CREATE INDEX IF NOT EXISTS orders_payout_scan_idx
  ON orders (paid_at, delivered_at)
  WHERE paid_at IS NOT NULL;

-- Backfill, and it is deliberately CONSERVATIVE rather than clever.
--
-- Existing paid orders have no paid_at. Leaving it NULL would make every one of them permanently
-- un-payable — money owed to a real seller that no run would ever pick up. So paid orders inherit
-- created_at: within the checkout flow those are seconds apart, and for the demo/seed data this
-- runs against they are the same second.
--
-- delivered_at is NOT backfilled from updated_at for delivered orders, even though it is tempting
-- and would look tidier. updated_at is the last touch of any field, so for an old order it is very
-- likely LATER than the real delivery, which would extend the hold rather than shorten it — wrong
-- in the safe direction, but wrong. Those orders fall through to the payment-based fallback clock
-- (`FALLBACK_DAYS_AFTER_PAYMENT`), which is exactly the case that constant exists for.
UPDATE orders SET paid_at = created_at WHERE payment_status = 'paid' AND paid_at IS NULL;

-- ============================================================================
-- MONEY_EVENTS — the journal gains a seller dimension
-- ============================================================================
--
-- Until now every row in the journal was identifiable by order, checkout or store, because every
-- event was something happening to a purchase. A payout is not: it spans an arbitrary set of
-- orders across an arbitrary set of the seller's stores, and belongs to none of them. Without this
-- column the four new event types would be recordable but not FINDABLE — "show me everything that
-- happened to this seller's money" is exactly the question a payout dispute starts with, and the
-- journal is the independent record that question has to be answered from.
ALTER TABLE money_events ADD COLUMN IF NOT EXISTS seller_id uuid REFERENCES sellers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS money_events_seller_idx
  ON money_events (seller_id, at DESC)
  WHERE seller_id IS NOT NULL;

-- ============================================================================
-- SELLERS — what a payout needs to exist, and what an invoice needs to be legal
-- ============================================================================

-- All nullable, and that is a product decision with a memory behind it
-- (feedback_seller_form_burden): a bank account is NOT asked for at registration or at
-- store-opening. A seller uploads a catalog, designs a store and takes orders without ever seeing
-- these fields; they are required only when there is a real balance to send, and until then the
-- balance accrues and is never forfeited (terms.astro says so in those words).
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS bank_code           text;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS bank_branch         text;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS bank_account        text;
-- The name the account is held under. Kept separate from `sellers.name` on purpose: a bank rejects
-- a transfer whose payee name does not match the account, and the account is usually in the
-- BUSINESS's name while `name` is the person who signed up.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS bank_account_holder text;
-- ח.פ / מספר עוסק, and the type that decides how the seller's invoice to the buyer must look
-- (עוסק פטור issues no VAT). Sellers are registered businesses only — AI_INSTRUCTIONS.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS business_id         text;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS business_type       text
  CHECK (business_type IS NULL OR business_type IN ('exempt', 'licensed', 'company'));

-- ============================================================================
-- SELLER_PAYOUTS — a bank transfer either left or it did not
-- ============================================================================

CREATE TABLE IF NOT EXISTS seller_payouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id      uuid NOT NULL REFERENCES sellers(id) ON DELETE RESTRICT,
  -- 'YYYY-MM' in the BUSINESS calendar (lib/business-day.ts#businessMonthKey), never UTC. A payout
  -- run just after midnight Israel time on the 1st would otherwise be filed under the previous
  -- month and the UNIQUE below would let the month be paid twice.
  period_key     text NOT NULL,
  amount_agorot  bigint NOT NULL CHECK (amount_agorot > 0),
  -- pending: row exists, no money has moved. sent: handed to the bank. paid: confirmed.
  -- failed: the bank rejected it — the row STAYS, and the amount returns to payable through the
  -- balance calculation rather than by deleting evidence. A money row is never deleted.
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sent', 'paid', 'failed')),
  -- The bank details AS THEY WERE when the transfer was made, copied not referenced. A seller who
  -- changes bank next year must not silently rewrite the history of where their money went — this
  -- is the column that answers "which account did the March payout actually go to".
  bank_snapshot  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  detail         text
);

-- **The single most important line in this migration.** The payout job is a scheduled task that can
-- be re-run — by a retry, by two servers, by someone re-triggering it after a crash halfway. Making
-- (seller, period) unique means the second attempt fails on the constraint instead of sending a
-- second transfer. The job does not check-then-insert; it inserts and lets this decide.
CREATE UNIQUE INDEX IF NOT EXISTS seller_payouts_seller_period_idx
  ON seller_payouts (seller_id, period_key);

CREATE INDEX IF NOT EXISTS seller_payouts_seller_recent_idx
  ON seller_payouts (seller_id, created_at DESC);

-- ============================================================================
-- SELLER_LEDGER_ADJUSTMENTS — everything that moves the balance and is not an order
-- ============================================================================

CREATE TABLE IF NOT EXISTS seller_ledger_adjustments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     uuid NOT NULL REFERENCES sellers(id) ON DELETE RESTRICT,
  -- Set when the adjustment traces to one order, which is the common case (a refund clawback).
  -- ON DELETE SET NULL rather than CASCADE: the debt outlives the row it came from.
  order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN (
                  -- Money already paid out for an order that then stopped counting. Without this
                  -- the platform silently absorbs every post-payout refund (refund-owed.ts).
                  'refund_clawback',
                  -- The card issuer reversed the buyer's charge.
                  'chargeback',
                  -- ⚠️ Set-off of a debt that is NOT the sales commission — a failed subscription
                  -- or ad charge recovered from the balance. Defined here so the shape exists, and
                  -- deliberately NOT written by any code path yet: setting off an unrelated debt
                  -- against money we hold as an agent is exactly the move that muddies "כספי מעבר",
                  -- which is the basis the whole model rests on. Owner + רו״ח decision,
                  -- docs/legal-brief-agent-model.md §6.5.
                  'setoff_subscription',
                  'setoff_ad',
                  -- Human correction. Always carries `detail`.
                  'manual'
                )),
  -- SIGNED. Negative reduces what we owe the seller, positive increases it. Signed rather than a
  -- separate direction column because every consumer just sums this table, and a direction flag is
  -- a second thing to get wrong at each of them.
  amount_agorot bigint NOT NULL CHECK (amount_agorot <> 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  detail        text NOT NULL DEFAULT ''
);

-- One clawback per order per kind. A refund webhook that fires twice, or a seller cancelling an
-- already-cancelled order, must not debit the seller twice for one event.
CREATE UNIQUE INDEX IF NOT EXISTS seller_ledger_adjustments_order_kind_idx
  ON seller_ledger_adjustments (order_id, kind)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS seller_ledger_adjustments_seller_idx
  ON seller_ledger_adjustments (seller_id, created_at DESC);

-- ============================================================================
-- INVOICE_DOCUMENTS — both directions, because both are now our obligation
-- ============================================================================
--
-- Two different documents live in one table because they share every field that matters (who, how
-- much, which provider, what number came back) and differ only in `direction`:
--
--   seller_to_buyer   — the tax invoice for the whole order, issued IN THE SELLER'S NAME. Under the
--                       agent model the seller is the one selling, so the document is theirs; we
--                       produce it for them. One per order.
--   platform_to_seller — our invoice to the seller for commission + subscription + ad margin. One
--                       per seller per month.
--
-- ⚠️ NOTHING ISSUES THESE YET, and that is on purpose rather than unfinished. Issuing an invoice in
-- another business's name is not an API question, it is a tax question — מספר הקצאה binds a document
-- to the ISSUER's tax file, i.e. the seller's. Until the רו״ח answers (legal brief §6.3–6.4) the
-- rows can be planned and queued, and `lib/invoicing/` writes them through a console adapter, so
-- the day a provider is chosen it is a provider swap and not a new subsystem.

CREATE TABLE IF NOT EXISTS invoice_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction         text NOT NULL CHECK (direction IN ('seller_to_buyer', 'platform_to_seller')),
  -- Always set: the seller is either the issuer (seller_to_buyer) or the recipient
  -- (platform_to_seller), so every document belongs to exactly one seller either way.
  seller_id         uuid NOT NULL REFERENCES sellers(id) ON DELETE RESTRICT,
  order_id          uuid REFERENCES orders(id) ON DELETE SET NULL,
  -- 'YYYY-MM' business calendar, for the monthly platform→seller document.
  period_key        text,
  kind              text NOT NULL CHECK (kind IN
                      ('tax_invoice', 'receipt', 'tax_invoice_receipt', 'credit_note')),
  -- Gross including VAT, and the VAT within it. Both stored: the rate changes by law and by
  -- business_type (עוסק פטור charges none), so recomputing later from a rate constant would restate
  -- history at whatever rate is current.
  amount_agorot     bigint NOT NULL CHECK (amount_agorot >= 0),
  vat_agorot        bigint NOT NULL DEFAULT 0 CHECK (vat_agorot >= 0),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'issued', 'failed', 'cancelled')),
  provider          text,
  provider_doc_id   text,
  document_url      text,
  -- מספר הקצאה — the Israeli Tax Authority allocation number. Nullable because it applies above a
  -- threshold and because we may not be the issuer at all; when present it is the thing that makes
  -- the document deductible for the buyer, so it is stored rather than only linked.
  allocation_number text,
  issued_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  detail            text NOT NULL DEFAULT ''
);

-- One buyer-facing invoice per order. Same argument as seller_payouts: the issuing call is
-- retryable and a duplicate tax document is worse than a missing one — it has to be cancelled with
-- a credit note rather than deleted.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_documents_order_idx
  ON invoice_documents (order_id, direction)
  WHERE order_id IS NOT NULL;

-- One platform→seller invoice per seller per month.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_documents_seller_period_idx
  ON invoice_documents (seller_id, period_key, direction)
  WHERE period_key IS NOT NULL;

-- The seller's own "my documents" list, and the retry sweep for anything left pending.
CREATE INDEX IF NOT EXISTS invoice_documents_seller_recent_idx
  ON invoice_documents (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoice_documents_pending_idx
  ON invoice_documents (created_at)
  WHERE status = 'pending';
