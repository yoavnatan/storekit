-- 0027_search_text_variants — a product becomes findable by its colours and flavours.
--
-- `search_text` (0006) was built from name + tags. A seller who sells a shirt in אדום/צהוב/שחור
-- types those words once, as a variant dimension, and never again — on the product page they are
-- swatches, so repeating them in the name would be noise. Search never read that column, so
-- "צהוב" returned NOTHING in a store that sells yellow. Not a weak result: an empty one, which a
-- shopper reads as "they don't have it" and leaves.
--
-- **Which values join, and why the test is on the VALUE not the dimension.** A size rubric is
-- `36, 37, 38…`; folding those in makes nearly every garment answer to "38" and buys a query
-- nobody types alone. A whitelist of dimension NAMES fails in the wrong direction, because sellers
-- name dimensions freely and "ניחוח"/"חומר" would be silently dropped. So a value joins when it
-- carries a letter and is at least two characters — `XL` in, `S` and `42` out. The rule and the
-- whole argument live in `src/lib/product-search-text.ts`; this is its port, and
-- `tests/product-search-normalize.test.ts` compares the two character for character.
--
-- The letter test is an explicit `[a-zA-Z֐-׿]` and not `[[:alpha:]]`, which resolves
-- against the database ctype — it would mean one thing on Neon and another on a `C`-collation
-- test database, and the JS side has no such knob to match it with.
--
-- **Why a drop and re-add rather than an edit.** A `GENERATED ALWAYS AS` expression cannot be
-- altered in place, and the argument list changes, so `CREATE OR REPLACE` would only add an
-- overload. The whole file runs inside ONE transaction (scripts/db-migrate.mjs), which is what
-- makes this safe under the zero-downtime rule: `DROP COLUMN` takes an ACCESS EXCLUSIVE lock for
-- the duration, so a query from the still-running previous deploy WAITS on the lock and then sees
-- the new column — it never observes the table without `search_text`. The table rewrite is the
-- cost, and it is why this is worth doing while the catalogue is small.

CREATE FUNCTION product_search_text(p_name text, p_tags text[], p_variants jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT btrim(regexp_replace(
           regexp_replace(
             translate(
               regexp_replace(
                 lower(
                   coalesce(p_name, '') || ' '
                   || array_to_string(coalesce(p_tags, '{}'), ' ') || ' '
                   -- A subquery is legal here and would not be in the generation expression
                   -- itself: the column may only call an immutable function, and this is the
                   -- inside of one. `jsonb_typeof` guards both levels because these values come
                   -- from a JSONB column — the shape is what we wrote, not what is guaranteed,
                   -- and `jsonb_array_elements` on a non-array raises.
                   || coalesce((
                        SELECT string_agg(opt, ' ')
                        FROM jsonb_array_elements(
                               CASE WHEN jsonb_typeof(p_variants) = 'array'
                                    THEN p_variants ELSE '[]'::jsonb END) AS dim,
                             LATERAL jsonb_array_elements_text(
                               CASE WHEN jsonb_typeof(dim -> 'options') = 'array'
                                    THEN dim -> 'options' ELSE '[]'::jsonb END) AS opt
                        -- An unnamed rubric is not a choice — `variant-combo.ts#realDimensions`
                        -- drops it, `resolveSelection` refuses to buy through it, and a product
                        -- found by a value nobody can then select is a lie. The JS test is
                        -- truthiness on `dim.name`, which for everything `product-form.ts` can
                        -- emit (a string, or the key missing) is exactly this. The pin test
                        -- caught the first draft of this file without the line.
                        WHERE coalesce(dim ->> 'name', '') <> ''
                          AND length(btrim(opt)) >= 2
                          AND btrim(opt) ~ '[a-zA-Z֐-׿]'
                      ), '')),
                 '[֑-ׇ׳״’“”]', '', 'g'),
               'ןףךםץ', 'נפכמצ'),
             '[-_.,!?;:()\[\]{}/\\]', ' ', 'g'),
           '\s+', ' ', 'g'))
$fn$;

-- Dropping the column drops `store_products_search_trgm_idx` with it; it is recreated below.
ALTER TABLE store_products DROP COLUMN search_text;

ALTER TABLE store_products
  ADD COLUMN search_text text GENERATED ALWAYS AS (product_search_text(name, tags, variants)) STORED;

CREATE INDEX store_products_search_trgm_idx ON store_products USING gin (search_text gin_trgm_ops);

-- Only reachable now that nothing generates from it. Left in place it is a second, subtly
-- different definition of "what a product is findable by" — the exact thing this file exists to
-- keep singular.
DROP FUNCTION product_search_text(text, text[]);
