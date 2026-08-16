-- Partial returns — one item out of several, from the same store (decisions §4).
--
-- A JSONB array on the request rather than a child table, and the reason is what it holds: a list of
-- LINE POSITIONS with quantities, which has no identity of its own, is never queried across requests,
-- and is read only together with the request it belongs to. A table would buy joins nobody makes.
--
-- **Positions, not product ids.** `order_items.position` is the line's place in the order and is
-- already the thing that makes the receipt read the way it was bought (migration 0004). A product id
-- is ambiguous the moment one order holds the same product twice at different variants, and the
-- variants themselves are a JSONB blob whose equality is not a thing to build an identity on.
--
-- NULL means the WHOLE order — the ordinary case, and the one that existed before this column. A
-- request that names no lines returns everything, which is what every row written before today meant
-- and what the buyer's own screen offers by default.
ALTER TABLE return_requests
  ADD COLUMN IF NOT EXISTS returned_lines jsonb;

COMMENT ON COLUMN return_requests.returned_lines IS
  'Partial return: [{"position":0,"qty":1},...]. NULL = the whole order (decisions §4).';
