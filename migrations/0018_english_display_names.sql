-- Optional English display names, so an English page stops showing Hebrew where the platform has
-- no word of its own to use.
--
-- Two holes, one shape. `/stores`' filter chips, the homepage shelf headings and every store card
-- render a category the seller CHOSE, and a store name the seller WROTE. Both are seller data, so
-- neither can live in `translations.ts`, and both showed Hebrew to an English shopper. The twenty
-- platform seed categories got a code-level map on 2026-08-07 (store-taxonomy.ts#categoryLabel);
-- these two columns are for the part no map can cover — a category a seller invented, and a name
-- only its owner can say in English.
--
-- **Optional, and that is a requirement rather than a default** (owner, 2026-08-07): "צריך לצאת
-- מנקודת הנחה שהרבה מוכרים לא יודעים אנגלית". Both are nullable, both fall back to the Hebrew, and
-- nothing anywhere may refuse a save because one is empty. A required English field would lock a
-- Hebrew-speaking seller out of a form they must be able to finish.
--
-- **DISPLAY ONLY, and this is the load-bearing rule.** The Hebrew stays the identity in both cases:
-- `Store.categories` values, the `?category=` parameter, the homepage grouping key, the icon map's
-- key, the store slug, the product feed's title, JSON-LD, order records and every email. Only the
-- label a human reads changes. Translating an identity would fork the catalog by language — an
-- English visitor could not reach a store a Hebrew visitor can — and it would hand Google Merchant
-- Center two names for one shop, on the ONE account the whole platform shares.
--
-- `category_translations` is platform-wide rather than per-store on purpose: two sellers who both
-- tag themselves "אקלקטי" are in one category, so it needs one English label. The first seller to
-- name it names it for the shelf; the value is the primary key because that is what makes them the
-- same row rather than two.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS name_en TEXT;

CREATE TABLE IF NOT EXISTS category_translations (
  -- The Hebrew value exactly as it is stored in `stores.categories` — the identity.
  category TEXT PRIMARY KEY,
  name_en  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
