-- The seller offers money instead of a return (decisions §4).
--
-- "המוצר הגיע שרוט, הקונה מוכן להשאיר אותו תמורת החזר חלקי" — the cheapest outcome for everyone
-- when it fits: no postage either way, no damaged item coming back to a shelf it cannot be sold
-- from, and the buyer is compensated the same day instead of in a fortnight.
--
-- **It is the SELLER'S offer and the BUYER'S decision, and the state exists to hold that gap.**
-- The owner was explicit that a buyer cannot demand it — so a request cannot arrive already asking
-- for one — and equally that a seller cannot impose it, because the buyer's statutory right is to
-- return the goods and be made whole. `offered` is the only state in this machine where nobody is
-- late and nothing is owed yet: it is a question that has been asked.
--
-- Declining returns the case to `approved`, i.e. the ordinary return resumes exactly where it was.
-- That is why the offer is not a terminal branch: refusing it must cost the buyer nothing, or the
-- offer becomes a trap rather than a shortcut.
ALTER TABLE return_requests DROP CONSTRAINT IF EXISTS return_requests_status_check;
ALTER TABLE return_requests ADD CONSTRAINT return_requests_status_check
  CHECK (status IN ('requested', 'approved', 'rejected', 'in_transit',
                    'received', 'refunded', 'disputed', 'expired', 'offered'));
