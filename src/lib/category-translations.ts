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
 * **Nobody fills this table yet, and that is the current state rather than an oversight.** The
 * first attempt asked the SELLER for the label as they added the category. It was built, and the
 * owner cut it (2026-08-07): "אני חושב שזה רעיון רע כל הקטע הזה של לתת למוכר לתרגם, אולי אנחנו
 * אחת לכמה זמן נעשה תרגום או שנמצא לזה בהמשך פתרון יותר טוב כמו רכיב ai". He was right on his own
 * rule — it put a box in front of a seller who may not read English, and three passes at the UI
 * still left "which category is this for?" unanswered.
 *
 * So the table stays and the input went. It is the shape a platform-side pass wants — a periodic
 * translation, or whatever AI component ends up doing it — and that pass needs somewhere to put
 * its output. Reading is wired and guarded; only the writer is open.
 *
 * **Empty is a working state.** With no rows, `resolveCategoryLabel` returns the seed label for the
 * platform's own categories and the Hebrew for anything a seller invented — exactly what the site
 * did before this module existed. Nothing treats a missing translation as an error.
 *
 * **Platform-wide, not per-store.** Two sellers who both tag themselves "אקלקטי" are in ONE
 * category — they share a filter chip and a homepage shelf — so it needs one English label, not one
 * per shop. The Hebrew value is the primary key because that is what makes them the same row.
 *
 * **The label never becomes the identity.** The Hebrew value stays what `Store.categories` holds,
 * what `?category=` carries, what groups the homepage shelves and what `category-icons.ts` keys its
 * icon off. Only what a human reads changes. Translating the identity would fork the catalog by
 * language — an English visitor could not reach a store a Hebrew visitor can — and it is asserted
 * by `tests/english-display-names.test.ts`.
 */
import { rows } from './db.js';
import { categoryLabel } from './store-taxonomy.js';
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
