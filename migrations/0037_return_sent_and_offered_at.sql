-- Two clocks the returns mechanism could not run, because nothing recorded when they started.
--
-- Both come out of the owner's scenario sweep (2026-08-17), and each closed a hole that was reachable
-- in complete silence:
--
--   · `sent_at` — when the BUYER said he sent the product back. `in_transit` was a seller action, so a
--     seller who touched nothing let the request expire on day 7 and kept the money AND the goods.
--     The buyer's word is not proof and never refunds anything by itself; what it does is stop that
--     expiry and, after `IN_TRANSIT_PATIENCE_DAYS`, put the case in front of a person. Recorded
--     separately from `approved_at` because they answer different questions: one is when he was
--     allowed to send, the other is when he says he did.
--
--   · `offered_at` — when the seller offered money instead of a return. `offered` had NO clock, so a
--     buyer who never answered left the case open and that order's payout frozen indefinitely, with
--     nobody late and nothing to chase.
--
-- Neither can be derived from `updated_at`: any later edit — a note, an admin comment — moves that
-- column and would silently restart or skip a clock that decides where money goes.
ALTER TABLE return_requests
  ADD COLUMN IF NOT EXISTS sent_at    timestamptz,
  ADD COLUMN IF NOT EXISTS offered_at timestamptz;

COMMENT ON COLUMN return_requests.sent_at IS
  'When the BUYER declared he sent it back. A claim, never proof — only `received` may pay.';
COMMENT ON COLUMN return_requests.offered_at IS
  'When the seller offered a partial refund instead of a return. Starts the answer clock.';

-- The sweep asks for both every day, alongside the two clocks that already existed.
DROP INDEX IF EXISTS return_requests_clock_idx;
CREATE INDEX IF NOT EXISTS return_requests_clock_idx
  ON return_requests (status, approved_at, delivered_back_at, sent_at, offered_at);
