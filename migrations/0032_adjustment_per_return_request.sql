-- A partial return's clawback is idempotent on the REQUEST, not on the order.
--
-- ── The bug this closes, found in review before it shipped ──
-- `seller_ledger_adjustments` has carried `UNIQUE (order_id, kind) WHERE order_id IS NOT NULL` since
-- 0023, and it is right about the case it was written for: one cancellation, one clawback, however
-- many times the webhook fires.
--
-- Partial returns (0031) break that assumption, because one order can now be returned MORE THAN ONCE
-- — a buyer sends back the lamp this week and the shade next month, and each is a separate request
-- with its own refund. Both write `refund_clawback` for the same order, so the second hits
-- `ON CONFLICT ... DO NOTHING` and vanishes. The buyer is refunded twice and the seller is debited
-- once; the difference comes out of the platform, silently, with a row in the journal saying the
-- money was owed and nothing saying it was never recovered.
--
-- ── Why a column and two indexes rather than a new `kind` ──
-- A distinct kind per return would have to be generated, and `AdjustmentKind` is a closed union whose
-- whole value is that a reader can enumerate it. The identity that actually makes these rows distinct
-- is the request, so that is what the constraint keys on.
--
-- The old index keeps its exact meaning for every row that is not return-scoped: `WHERE
-- return_request_id IS NULL` leaves cancellations, chargebacks and set-offs under the same one
-- clawback per order they have always had. Existing rows all have NULL, so nothing is re-classified.
ALTER TABLE seller_ledger_adjustments
  ADD COLUMN IF NOT EXISTS return_request_id uuid REFERENCES return_requests(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS seller_ledger_adjustments_order_kind_idx;

CREATE UNIQUE INDEX IF NOT EXISTS seller_ledger_adjustments_order_kind_idx
  ON seller_ledger_adjustments (order_id, kind)
  WHERE order_id IS NOT NULL AND return_request_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS seller_ledger_adjustments_return_idx
  ON seller_ledger_adjustments (return_request_id)
  WHERE return_request_id IS NOT NULL;
