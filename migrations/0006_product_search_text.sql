-- 0006_product_search_text — platform search stops reading the whole catalogue (§3).
--
-- `site-search.ts` matched products by calling `getAllProducts()` and filtering in Node, on EVERY
-- header keystroke and every /search request. That is the one §3 caller on a shopper-facing path,
-- so it is the one that had to become a query first.
--
-- **Why a stored column and not `name ILIKE '%q%'`.** The matcher is not a substring test on the
-- raw text: `product-listing.ts#normalizeHe` strips nikud, folds the five final letters
-- (ןףךםץ → נפכמצ), drops geresh/quotes and turns punctuation into spaces, and only THEN requires
-- every query word to appear. The fold is not cosmetic — "ספר טלפונים" normalises to
-- "ספר טלפונימ", which is what lets a search for "טלפון" ("טלפונ") find it. A raw ILIKE would
-- silently stop matching exactly the Hebrew cases the normaliser exists for, so the normalisation
-- has to live on the stored side too.
--
-- **Why a function and not the expression inline.** A `GENERATED ALWAYS AS` expression must be
-- immutable, and `array_to_string` is not marked so (it reaches an element type's output function).
-- The wrapper asserts what is true for `text[]`: same input, same output, forever. Measured against
-- PGlite before it was written here — the SQL and the JS agree character for character on nikud,
-- sofit, geresh, punctuation and whitespace collapse, and `tests/product-search-normalize.test.ts`
-- keeps them agreeing.
--
-- The trigram index is what makes `search_text LIKE '%word%'` an index scan instead of a scan of
-- every product on the platform. `store_products_name_trgm_idx` (0001) stays: it covers the raw
-- name for anything matching what a seller literally typed.

CREATE FUNCTION product_search_text(p_name text, p_tags text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT btrim(regexp_replace(
           regexp_replace(
             translate(
               regexp_replace(
                 lower(coalesce(p_name, '') || ' ' || array_to_string(coalesce(p_tags, '{}'), ' ')),
                 '[֑-ׇ׳״’“”]', '', 'g'),
               'ןףךםץ', 'נפכמצ'),
             '[-_.,!?;:()\[\]{}/\\]', ' ', 'g'),
           '\s+', ' ', 'g'))
$fn$;

ALTER TABLE store_products
  ADD COLUMN search_text text GENERATED ALWAYS AS (product_search_text(name, tags)) STORED;

CREATE INDEX store_products_search_trgm_idx ON store_products USING gin (search_text gin_trgm_ops);
