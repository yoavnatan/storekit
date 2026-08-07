/**
 * English labels for the categories the platform did not write.
 *
 * `store-taxonomy.ts#categoryLabel` covers the twenty seed categories from a code map, which is
 * right for them: they are ours, they change only when we change them, and a build-time constant
 * cannot go stale. It cannot cover the other half. A seller may add a category the mall never
 * predicted — that is deliberate (`proposeCategory`, the zero-touch rule) — and one typed in Hebrew
 * has no twin anywhere in the codebase to look up. `/stores`' filter row showed exactly one such
 * chip in Hebrew inside an otherwise English row, which is what surfaced this (owner, 2026-08-07).
 *
 * So the seller supplies it, **optionally**, when they add the category. Owner, same day: "אסור
 * שזה יהיה חובה כי צריך לצאת מנקודת הנחה שהרבה מוכרים לא יודעים אנגלית." Nothing here treats a
 * missing translation as an error — `resolve()` hands back the Hebrew and the chip renders as the
 * seller wrote it, which is what happened before this module existed.
 *
 * **Platform-wide, not per-store.** Two sellers who both tag themselves "אקלקטי" are in ONE
 * category — they share a filter chip and a homepage shelf — so it needs one English label, not one
 * per shop. The Hebrew value is the primary key because that is what makes them the same row.
 * First seller to name it names it for the shelf; a later one does not overwrite, because the
 * shelf's label changing under the first seller is a worse outcome than a synonym they'd have
 * preferred (`INSERT … ON CONFLICT DO NOTHING`).
 *
 * **The label never becomes the identity.** The Hebrew value stays what `Store.categories` holds,
 * what `?category=` carries, what groups the homepage shelves and what `category-icons.ts` keys its
 * icon off. Only what a human reads changes. Translating the identity would fork the catalog by
 * language — an English visitor could not reach a store a Hebrew visitor can — and it is asserted
 * by `tests/english-display-names.test.ts`.
 */
import { query, rows } from './db.js';
import { categoryLabel, normalizeCategory } from './store-taxonomy.js';
import type { Lang } from '../i18n/translations.js';

interface TranslationRow { category: string; name_en: string }

/**
 * Every seller-supplied translation, as a Map keyed by the stored Hebrew value.
 *
 * Read once per request by the pages that render a category row, and handed down — the same shape
 * `store-categories.ts` uses, and for the same reason: turning a label lookup into a query would
 * make one chip row a dozen round-trips. The table is one row per non-seed category in existence,
 * so it stays small by construction.
 */
export async function getCategoryTranslations(): Promise<Map<string, string>> {
  const found = await rows<TranslationRow>('SELECT category, name_en FROM category_translations');
  return new Map(found.map((r) => [r.category, r.name_en]));
}

/**
 * The label a reader should see for a stored category value.
 *
 * Order is seed map → seller translation → the Hebrew itself. The seed map wins because those
 * twenty are the platform's own vocabulary and their wording is a copy decision, not a seller's:
 * a seller who somehow got a row in for "אופנה" must not be able to rename the shelf everyone
 * else's store sits on.
 */
export function resolveCategoryLabel(
  value: string,
  lang: Lang,
  translations: ReadonlyMap<string, string>,
): string {
  const trimmed = value.trim();
  if (lang === 'he') return trimmed;
  const seed = categoryLabel(trimmed, 'en');
  if (seed !== trimmed) return seed;
  return translations.get(trimmed) ?? trimmed;
}

/**
 * Record a seller's English label for a category, if they gave one.
 *
 * Silent no-op on an empty value — an untranslated category is the normal case, not a failure, and
 * nothing upstream may treat it as one. Also a no-op for a seed category: those are ours.
 */
export async function saveCategoryTranslation(category: string, nameEn: string | null | undefined): Promise<void> {
  const value = normalizeCategory(category);
  const label = (nameEn ?? '').trim();
  if (!value || !label) return;
  // A seed category already has a label we wrote; a seller cannot rename the shared shelf.
  if (categoryLabel(value, 'en') !== value) return;
  await query(
    'INSERT INTO category_translations (category, name_en) VALUES ($1, $2) ON CONFLICT (category) DO NOTHING',
    [value, label.slice(0, MAX_TRANSLATION_LENGTH)],
  );
}

/** Same ceiling the Hebrew label has (`MAX_CATEGORY_LENGTH`) — a sentence is a description. */
export const MAX_TRANSLATION_LENGTH = 24;

/**
 * Form-field prefix carrying a seller's English label: `categoryEn:<the Hebrew value>`.
 *
 * Declared here rather than typed into both the picker and `api/store.ts` — a name agreed in two
 * files is the shape that silently stops matching, and the failure would be invisible: the save
 * succeeds, the label is simply never stored, and the chip stays Hebrew.
 */
export const CATEGORY_EN_FIELD_PREFIX = 'categoryEn:';
