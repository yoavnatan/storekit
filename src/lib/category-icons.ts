/**
 * Which icon a STORE category (`store-taxonomy.ts`) gets.
 *
 * Why this can exist at all (the question that blocked it — user, 2026-07-29:
 * "there are so many category types, how would we know which icon for each?"):
 * because there are two different category systems, and only ONE of them is
 * open-ended. This module covers the closed one — the platform vocabulary, a
 * curated list WE wrote (`SEED_CATEGORIES`), shown as `/stores` filter chips and
 * homepage shelf headings. Twenty labels, twenty hand-picked icons, done.
 *
 * A store's OWN product category tree (`store-categories.ts`) is free text the
 * seller types, unbounded — it deliberately gets NO icons. A generic icon
 * repeated down a chip row carries less meaning than the plain label and reads
 * as decoration; the store page makes those chips legible by other means
 * (product counts + a chevron for a branch that drills down).
 *
 * A seller MAY add a category outside the seed list (zero-touch rule — the mall
 * can't predict every niche), so the mapping can't be a bare lookup. It falls
 * back through `findSimilarCategories`, the same word-overlap matcher the
 * duplicate-suggestion flow already uses, so "חשמל ואלקטרוניקה" inherits
 * אלקטרוניקה's icon rather than dropping to the neutral tag. That's the whole
 * reason the fallback is shared code and not a second keyword list: one place
 * decides what "the same category" means.
 *
 * Pure module — no fs, no Astro. The icon ARTWORK lives in
 * `components/CategoryIcon.astro`; this file only names the icon.
 * Covered by tests/category-icons.test.ts.
 */

import { SEED_CATEGORIES, findSimilarCategories, normalizeCategory } from './store-taxonomy.js';

export type CategoryIconKey =
  | 'fashion' | 'footwear' | 'bag' | 'jewelry' | 'beauty' | 'electronics'
  | 'accessories' | 'home' | 'kitchen' | 'furniture' | 'sports' | 'food'
  | 'toys' | 'baby' | 'pets' | 'books' | 'tools' | 'car' | 'gift' | 'store'
  | 'plants' | 'garden' | 'judaica' | 'computers' | 'kids' | 'music'
  | 'nature' | 'cleaning' | 'disposables' | 'phone' | 'flowers'
  | 'all' | 'default';

/** Seed label → icon. Keyed by the normalized label so a lookup can't be defeated
 *  by casing/spacing the way a raw-string map would be. Every entry in
 *  `SEED_CATEGORIES` must appear here — asserted in the tests, so adding a seed
 *  without an icon fails the suite instead of silently rendering the tag. */
const SEED_ICONS: Readonly<Record<string, CategoryIconKey>> = {
  'אופנה': 'fashion',
  'הנעלה': 'footwear',
  'תיקים': 'bag',
  'תכשיטים': 'jewelry',
  'טיפוח': 'beauty',
  'אלקטרוניקה': 'electronics',
  'מחשבים': 'computers',
  'סלולר': 'phone',
  'אביזרים': 'accessories',
  'לבית': 'home',
  'מטבח': 'kitchen',
  'ריהוט': 'furniture',
  'ספורט': 'sports',
  'מזון': 'food',
  'פרחים': 'flowers',
  'צמחים': 'plants',
  'צעצועים': 'toys',
  'לתינוק': 'baby',
  'חיות מחמד': 'pets',
  'ספרים': 'books',
  'כלי עבודה': 'tools',
  'רכב': 'car',
  'מתנות': 'gift',
  'כלבו': 'store',
};

/**
 * Labels OUTSIDE the seed vocabulary that are common enough in an Israeli mall to
 * deserve real artwork rather than the neutral tag.
 *
 * Kept separate from `SEED_ICONS` deliberately: this map widens ICON coverage only.
 * It does not add anything to `SEED_CATEGORIES`, which is the seller-facing picker
 * vocabulary and a product decision — a category belongs there because the mall
 * wants to steer sellers toward it, not because someone drew a glyph. A seller who
 * types one of these still goes through the normal `proposeCategory` flow; they
 * just don't land on a generic tag when they do.
 *
 * These are also inheritance sources, so "צמחי בית" reaches the plant icon the
 * same way "חשמל ואלקטרוניקה" reaches אלקטרוניקה's.
 */
const ALIAS_ICONS: Readonly<Record<string, CategoryIconKey>> = {
  'לגינה': 'garden',
  'גינה': 'garden',
  'יודאיקה': 'judaica',
  'ציוד מחשבים': 'computers',
  'מחשבים': 'computers',
  'לילדים': 'kids',
  'ילדים': 'kids',
  // Also the fix for the one false positive store-taxonomy.ts documents: "כלי נגינה"
  // shares only the weak token "כלי" with the seed "כלי עבודה", so without an exact
  // entry here it would land on the neutral tag rather than a wrench — right, but
  // needlessly blank for a category this common.
  'מוזיקה': 'music',
  'כלי נגינה': 'music',
  // Deliberately the SAME icon as the seed טיפוח rather than a lipstick of its own:
  // on a mall they're one aisle, and two glyphs for one aisle is the confusing option.
  'קוסמטיקה': 'beauty',
  'טבע': 'nature',
  'מוצרי טבע': 'nature',
  // Both spellings are in common use and normalization won't unify them (different
  // strings, not different casing), so both are listed.
  'נקיון': 'cleaning',
  'ניקיון': 'cleaning',
  'חד פעמי': 'disposables',
  'חד פעמיים': 'disposables',
  'כלים חד פעמיים': 'disposables',
};

/** Everything a label may inherit an icon from, seeds first so a seed always wins
 *  a tie — the seed list is the curated one. */
const INHERITABLE: readonly string[] = [...SEED_CATEGORIES, ...Object.keys(ALIAS_ICONS)];

/** The icon for a category label. Never throws and never returns empty — an
 *  unrecognised label gets the neutral tag, which is a legitimate outcome, not a
 *  failure state. */
export function categoryIconKey(label: string): CategoryIconKey {
  const key = normalizeCategory(label);
  if (!key) return 'default';
  const exact = SEED_ICONS[key] ?? ALIAS_ICONS[key];
  if (exact) return exact;
  // Unknown label: inherit from the closest known one by shared significant word.
  // findSimilarCategories preserves INHERITABLE's order, which is curated (seeds
  // first, broadest first), so taking the first hit is deterministic.
  for (const known of findSimilarCategories(key, INHERITABLE)) {
    const norm = normalizeCategory(known);
    const hit = SEED_ICONS[norm] ?? ALIAS_ICONS[norm];
    if (hit) return hit;
  }
  return 'default';
}
