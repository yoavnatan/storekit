-- Returns — the buyer sends back an order that WAS delivered.
--
-- Two separate things, and keeping them separate is the whole point (decisions doc §0):
--
--   1. `orders.shipping_status` gains 'returned'. It is NOT 'cancelled'. A cancelled order never
--      completed — nothing reached the buyer and the seller did not do the work. A returned one did
--      complete: packed, shipped, delivered, and only then sent back. Recording a return as a
--      cancellation would erase the seller's fulfilment from every record that reads that column,
--      and would make "orders that failed to arrive" and "products people sent back" — two
--      completely different business problems — indistinguishable in every report forever.
--
--   2. `return_requests` is its own table because a request has a LIFE the order does not. It opens
--      while the order is still `delivered`, moves through approval, shipment and receipt, can be
--      disputed, and only at the very end does it change the order at all. Storing its state as
--      more order columns would mean an order carrying half a request, with no way to hold two of
--      them or to remember one that was refused.
--
-- The status CHECK on `orders` is rewritten rather than dropped: a new status must arrive as a
-- migration so it cannot be written by one deploy and misread by another (0001's own note).

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_shipping_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_shipping_status_check
  CHECK (shipping_status IN ('pending', 'processing', 'ready', 'shipped', 'delivered', 'cancelled', 'returned'));

CREATE TABLE IF NOT EXISTS return_requests (
  id                uuid PRIMARY KEY,
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  -- Denormalised so the seller's and admin's lists never join through orders to find whose case
  -- this is. It is the same slug `order_stores` carries; an order is single-store by construction
  -- (checkout writes one per store), so there is exactly one answer.
  store_slug        text NOT NULL,

  -- ── What the buyer said ──
  -- The closed list from decisions §1. 'not_arrived' is deliberately IN it: the buyer presses the
  -- same button, and the platform — not the seller — then owns the case (decisions §8).
  reason            text NOT NULL CHECK (reason IN ('changed_mind', 'damaged', 'wrong_item', 'not_arrived')),
  buyer_note        text NOT NULL DEFAULT '',
  buyer_photo_url   text,

  -- ── Where the case stands ──
  -- requested  — opened, nobody has answered yet
  -- approved   — the buyer may send it back; the handover clock runs
  -- rejected   — outside the statutory window and the seller said no
  -- in_transit — the carrier has it
  -- received   — it reached the seller
  -- refunded   — the money is owed back (a `refund_due` row exists); settlement needs a provider
  -- disputed   — the seller says the parcel was empty/used; every clock stops
  -- expired    — approved and never sent. The money is released to the seller
  status            text NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested', 'approved', 'rejected', 'in_transit',
                                        'received', 'refunded', 'disputed', 'expired')),

  -- TRUE when the request was opened inside the statutory 14 days, i.e. the buyer had a legal right
  -- and the seller had no say. Stored rather than recomputed because it is a fact about the moment
  -- the request was made, and `STATUTORY_RETURN_DAYS` is a number that may change — a case decided
  -- under one window must not silently re-decide itself under another (decisions §3).
  within_statutory  boolean NOT NULL,

  -- Who pays to send it back, decided at approval from the reason (decisions §5).
  return_shipping_payer text NOT NULL DEFAULT 'buyer' CHECK (return_shipping_payer IN ('buyer', 'seller')),

  -- ── The money ──
  -- What the buyer gets back, in agorot. Includes the original shipping only when the goods were
  -- faulty (decisions §4), so it is computed at approval and stored — not derived later from a
  -- policy that may have moved.
  refund_agorot     bigint NOT NULL DEFAULT 0 CHECK (refund_agorot >= 0),
  -- A partial refund the seller OFFERED instead of a return, and the buyer accepted. Null = no offer.
  partial_offer_agorot bigint CHECK (partial_offer_agorot IS NULL OR partial_offer_agorot > 0),

  tracking_number   text,
  seller_note       text NOT NULL DEFAULT '',
  admin_note        text NOT NULL DEFAULT '',

  -- ── The clocks (decisions §3, §4, §5) ──
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Start of the 7-day handover window.
  approved_at       timestamptz,
  -- The carrier says it is with the seller. Start of the 2-business-day auto-refund clock, which
  -- runs from ARRIVAL and never from the request — a slow post must not refund a buyer before
  -- anyone opened the box (owner's correction, decisions §4).
  delivered_back_at timestamptz,
  closed_at         timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One OPEN case per order. A buyer who was refused may open another; two live at once cannot exist,
-- because two clocks would then run on one order's money and the payout hold would have to choose.
CREATE UNIQUE INDEX IF NOT EXISTS return_requests_one_open_per_order
  ON return_requests (order_id)
  WHERE status NOT IN ('rejected', 'refunded', 'expired');

-- The seller's tab and the admin's queue: open cases, oldest first.
CREATE INDEX IF NOT EXISTS return_requests_store_open_idx
  ON return_requests (store_slug, created_at)
  WHERE status NOT IN ('rejected', 'refunded', 'expired');

-- The scheduled job's two sweeps: expire an approved case nobody sent, and refund a received one
-- the seller has not touched.
CREATE INDEX IF NOT EXISTS return_requests_clock_idx
  ON return_requests (status, approved_at, delivered_back_at);

CREATE INDEX IF NOT EXISTS return_requests_order_idx ON return_requests (order_id, created_at DESC);
