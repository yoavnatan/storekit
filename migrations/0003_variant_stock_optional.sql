-- 0003 — a variant combo may carry a SKU without carrying a stock override.
--
-- `variantStock` has always been a PARTIAL map: a combo with no entry sells from the product's
-- shared `stock` pool (store-products.ts#resolveStockField). `variantSku` is a separate partial
-- map with its own keys, and 0001 gave both a single row per combo — so a combo that holds only a
-- code had to be written with `stock = 0`, which is not "no override", it is "sold out". A blue
-- shirt whose only per-combo fact is its barcode would have stopped being purchasable the moment
-- the catalog moved, with no error and no failing test.
--
-- NULL is the missing value: no override, read the shared pool. `CHECK (stock >= 0)` still holds
-- (a NULL check evaluates to unknown, which passes), and the atomic decrement is unaffected —
-- `WHERE stock >= $qty` never matches a NULL row, and store-products.ts resolves which bucket a
-- selection governs before it writes, exactly as the file version did.
ALTER TABLE product_variant_stock ALTER COLUMN stock DROP NOT NULL;
ALTER TABLE product_variant_stock ALTER COLUMN stock DROP DEFAULT;
