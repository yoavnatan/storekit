-- The clothing shelf is called בגדים, and there is only one of it.
--
-- ── Why the label moved (owner, 2026-08-25) ──
-- *"אין לי בקטגוריות של החנויות 'בגדים'? זה דבר כל כך בסיסי."* — and he is right about the word.
-- 'אופנה' was carrying it, but a shopper looking for clothes types בגדים, and the seed vocabulary is
-- what a SELLER picks from, so the label has to be the one both sides say.
--
-- ── Why this is a migration and not just an edit to the seed list ──
-- **The Hebrew string IS the category's identity** (`lib/store-taxonomy.ts` says so at length): it
-- is what `stores.categories` stores, what `?category=` carries, what groups the homepage shelves,
-- and what `category-icons.ts`, `spec-vocabulary.ts` and `merchant-category.ts` each key off.
-- Renaming the seed alone would have left every existing shop on a shelf the vocabulary no longer
-- knows — no icon, no spec names, and no merchant code, which is the field a seller then has to
-- answer by hand out of PayMe's several-hundred-row trade list.
--
-- ── And no duplicates (owner, same message: *"שלא יהיו כפילויות"*) ──
-- A shop that somehow carried BOTH would end up with בגדים twice after a plain replace, which is
-- the one thing the vocabulary exists to prevent. So the array is rebuilt through `DISTINCT`, and
-- the original order is preserved with `WITH ORDINALITY` — the order is the seller's own choice and
-- `spec-vocabulary.ts` reads the FIRST category as "what this shop mostly is".
UPDATE stores s
   SET categories = sub.rebuilt
  FROM (
    SELECT s2.id,
           ARRAY(
             SELECT c.label
               FROM (
                 SELECT CASE WHEN e.value = 'אופנה' THEN 'בגדים' ELSE e.value END AS label,
                        MIN(e.ord) AS first_seen
                   FROM unnest(s2.categories) WITH ORDINALITY AS e(value, ord)
                  GROUP BY 1
               ) AS c
              ORDER BY c.first_seen
           ) AS rebuilt
      FROM stores s2
     WHERE s2.categories IS NOT NULL
       AND 'אופנה' = ANY(s2.categories)
  ) AS sub
 WHERE s.id = sub.id;
