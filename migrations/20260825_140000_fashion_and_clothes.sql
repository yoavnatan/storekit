-- 'אופנה' comes back, and 'בגדים' stays. They are two shelves.
--
-- ── The correction (owner, 2026-08-25) ──
-- *"אבל עדיין צריך אופנה (יש עוד דברים תחת אופנה חוץ מבגדים)"*, after
-- `20260825_120000_category_bgadim.sql` had renamed one into the other on his earlier
-- *"שלא יהיו כפילויות"*. Both instructions are right and they are not in conflict: what must not
-- exist is TWO WORDS FOR ONE SHELF, and these are two shelves. אופנה is a look — a boutique whose
-- rails cross clothes, bags and jewellery. בגדים is garments. A shop that is both picks both;
-- `MAX_CATEGORIES_PER_STORE` is 3 and this is what the allowance is for.
--
-- ── What this moves ──
-- The earlier migration turned every shop tagged אופנה into בגדים. Nothing had ever been tagged
-- בגדים before it ran, so every row now carrying that label was a fashion shop an hour ago — the
-- seeded showcase and demo stores, which are boutiques. They go back.
--
-- A seller who has since picked בגדים deliberately would be moved by this too, and that is
-- accepted rather than worked around: the window is one hour on a development database with no
-- real sellers, and a guess about intent would be worse than a clean reversal.
UPDATE stores s
   SET categories = sub.rebuilt
  FROM (
    SELECT s2.id,
           ARRAY(
             SELECT c.label
               FROM (
                 SELECT CASE WHEN e.value = 'בגדים' THEN 'אופנה' ELSE e.value END AS label,
                        MIN(e.ord) AS first_seen
                   FROM unnest(s2.categories) WITH ORDINALITY AS e(value, ord)
                  GROUP BY 1
               ) AS c
              ORDER BY c.first_seen
           ) AS rebuilt
      FROM stores s2
     WHERE s2.categories IS NOT NULL
       AND 'בגדים' = ANY(s2.categories)
  ) AS sub
 WHERE s.id = sub.id;
