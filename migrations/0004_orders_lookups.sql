-- 0004_orders_lookups — what `orders` needs that 0001 left out: one column, three indexes.
--
-- 0. `order_items.position`. The lines of an order were a JSON ARRAY, so they had an order, and it
--    was the order the buyer built the cart in — which is the order their confirmation email lists
--    and the order the seller packs from. A table has no such thing (§7.13), and every candidate
--    sort key here is wrong in the same quiet way: `id` is a `deterministicUuid` of the line's
--    import sequence, so it sorts by hash; `product_name` reshuffles the packing list whenever a
--    seller renames a product; price sorts a receipt by price. None of them ERRORS — the order card
--    just comes back in a different sequence than the email that was already sent about it. The
--    column carries the array index, and the sequence stops being a coincidence of storage.
--
-- All three are the same species: a read that was a full in-memory pass over a JSON array, and so
-- cost nothing to *plan*, becomes a query whose shape decides whether it scans the table. At 207
-- orders every one of them is fast either way; the point of adding them now is that the table an
-- index is free to build on is the empty one (§6).
--
-- 1. `order_items(store_slug)`. `orderBelongsToStore` has always answered "does this store appear
--    in the items OR in the storeSubtotals map", and the query keeps both halves — measured, the
--    two agree on every one of today's 207 orders, but they are two independent writes and the
--    predicate that guards seller access to an order is the wrong place to start assuming they
--    can't diverge. 0001 indexed `order_items(order_id)` and `(product_id)`; the store side of the
--    OR had nothing, so a seller opening their orders tab scanned every line item ever sold on the
--    platform.
--
-- 2. `money_events(type, at DESC)`. The admin journal's type filter narrows the WHOLE journal
--    before any paging (money-events.ts#getMoneyEvents documents why it must). Without this the
--    narrowing reads every row ever appended to a table nothing is deleted from.
--
-- 3. Two more trigram indexes on `money_events`. §4 named four searchable columns
--    (`order_id/checkout_ref/store_slug/detail`); 0001 shipped two. The admin's free-text box
--    matches an order id and a checkout ref — pasting either is the single most likely thing an
--    owner does with that box, since both are what the rest of the admin hands them to copy.

-- DEFAULT 0 rather than NOT NULL with no default: existing rows predate the concept, and every
-- order in the data today holds its lines in one store, so a stable tie-break on `id` behind
-- `position` keeps them in a fixed sequence instead of failing the migration over history.
ALTER TABLE order_items ADD COLUMN position integer NOT NULL DEFAULT 0;

CREATE INDEX order_items_store_idx ON order_items (store_slug);

CREATE INDEX money_events_type_idx ON money_events (type, at DESC);

CREATE INDEX money_events_order_trgm_idx ON money_events USING gin (order_id gin_trgm_ops);
CREATE INDEX money_events_checkout_trgm_idx ON money_events USING gin (checkout_ref gin_trgm_ops);
