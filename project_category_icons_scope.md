---
name: project-category-icons-scope
description: "Category icons exist ONLY for the platform vocabulary; a store's own free-text categories deliberately get none"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3db5fb0b-b7b4-4429-8d5a-a9c391a446e2
  modified: 2026-07-29T14:12:24.802Z
---

Built 2026-07-29 (CURRENT_TASK סשן ב׳ — "the categories feel dead"). The split is the
answer to "there are so many category types, how would we know which icon for each?":

- **Platform store categories** (`lib/store-taxonomy.ts`, 20 curated seeds) → hand-drawn
  SVG per seed in `components/CategoryIcon.astro`, resolved by `lib/category-icons.ts`.
  Plus an `ALIAS_ICONS` map for common NON-seed labels (צמחים/לגינה/יודאיקה/ציוד
  מחשבים/לילדים/מוזיקה־כלי נגינה). **Icon coverage and picker vocabulary are separate
  on purpose:** an alias only stops a label landing on the neutral tag; it does NOT add
  the category to `SEED_CATEGORIES`, which is a product decision about what the mall
  steers sellers toward. Adding an icon is safe; adding a seed needs the user.
  Shown on `/stores` filter chips + homepage category shelf headings (the icon REPLACES
  the rotating colour dot there, same slot/colour). A seller-added category inherits the
  nearest seed's icon via `findSimilarCategories` — the same word-overlap matcher the
  duplicate-suggestion flow uses — else a neutral tag.
- **A store's own product categories** (`lib/store-categories.ts`, free text, unbounded)
  → **no icons, on purpose.** They get product counts + a drill-down chevron instead
  (`countProductsPerCategory`, counts the whole subtree so the number matches what the
  chip actually filters to).

**Why:** a generic icon repeated down a chip row says less than the plain label and reads
as decoration. Don't "finish the job" by adding icons to the store-level chips, and don't
propose per-seller icon pickers or AI-guessed icons for them — that was the rejected path.

Related: [[project_ai_tagging_deferred]] (same shape of answer — don't guess per-item
metadata on free text), [[feedback_design_philosophy]].
