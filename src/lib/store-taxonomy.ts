/**
 * The shared vocabulary of STORE categories — the labels a seller tags their whole
 * store with (`Store.categories`), which drive `/stores`' filter chips and the
 * homepage's category shelves.
 *
 * Why this exists (user, 2026-07-28): the field was free text, so seller A typing
 * "אלקטרוניקה" and seller B typing "חשמל ואלקטרוניקה" produced two categories for
 * one thing — which splits the filter, splits the shelf, and means neither reaches
 * the 2-store minimum a shelf needs (`home-feed.ts`). One vocabulary fixes all three.
 *
 * The model is a curated seed list PLUS whatever stores already use, and a seller
 * may add a genuinely new one — the mall can't predict every niche, and gating
 * additions on owner approval would break the zero-touch rule. What makes that safe
 * is `proposeCategory()`: it normalizes, rejects unsafe/spam wording (reusing
 * `spam-filter.ts`, the same gate all seller free text goes through), and — the part
 * that actually solves the duplicate problem — surfaces existing categories that
 * share a significant word, so "חשמל ואלקטרוניקה" offers "אלקטרוניקה" first.
 *
 * Case-normalizing alone would NOT have caught that pair: they're different strings.
 * Overlap has to be measured on words, not on the whole label.
 *
 * Pure module — no fs, no Astro. Covered by tests/store-taxonomy.test.ts.
 */

import { findSpamKeyword } from './spam-filter.js';

/** Longest a category label may be — a sentence is a description, not a category. */
export const MAX_CATEGORY_LENGTH = 24;

/** Most categories one store may carry. Past this it isn't categorised, it's stuffed. */
export const MAX_CATEGORIES_PER_STORE = 3;

/**
 * The curated base vocabulary. Broad on purpose — a category exists to group
 * SHOPPERS' intent across stores, not to describe one shop precisely (that's what
 * the store's own product category tree, `store-categories.ts`, is for).
 */
export const SEED_CATEGORIES: readonly string[] = [
  'אופנה',
  'הנעלה',
  'תיקים',
  'תכשיטים',
  'טיפוח',
  'אלקטרוניקה',
  'אביזרים',
  'לבית',
  'מטבח',
  'ריהוט',
  'ספורט',
  'מזון',
  'צעצועים',
  'לתינוק',
  'חיות מחמד',
  'ספרים',
  'כלי עבודה',
  'רכב',
  'מתנות',
  'כלבו',
];

/** Words too generic to prove two categories are the same thing. Hebrew conjunctions
 *  and articles fuse onto the next word (ו/ה/ב/ל/מ/ש), so they're stripped as
 *  prefixes below rather than matched as standalone tokens. */
const STOPWORDS = new Set(['של', 'עם', 'את', 'לכל', 'כל', 'and', 'the', 'for', 'of']);

/** Trim, collapse inner whitespace, drop edge punctuation. Deliberately does NOT
 *  lowercase Hebrew (no case) but does for latin, so "Fashion"/"fashion" unify. */
export function normalizeCategory(raw: string): string {
  return raw
    .trim()
    .replace(/[\s ]+/g, ' ')
    .replace(/^[־\-–—,.;:'"`]+|[־\-–—,.;:'"`]+$/g, '')
    .trim()
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase() === c ? c : c);
}

/** Significant words of a label, with Hebrew prefix letters stripped so
 *  "וחשמל" and "חשמל" compare equal. */
export function categoryTokens(name: string): string[] {
  return normalizeCategory(name)
    .split(/[\s/,־\-]+/)
    .map((w) => w.replace(/^[והבלמש]/, (m, ...a) => (w.length > 3 ? '' : m)))
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** A shared word only proves two categories are the same thing when it carries
 *  enough meaning. Short Hebrew words usually don't: "כלי נגינה" and "כלי עבודה"
 *  share "כלי" and are completely different categories (caught in the browser,
 *  2026-07-28). So a 3-letter token counts ONLY when it is the entire label on one
 *  side — that keeps "רכב" ↔ "חלקי רכב" working while dropping the false positive. */
const STRONG_TOKEN_LENGTH = 4;

/** Existing categories that share a significant word with `candidate` — the
 *  near-duplicate check. Exact matches are included (they're the strongest hit). */
export function findSimilarCategories(candidate: string, existing: readonly string[]): string[] {
  const mine = categoryTokens(candidate);
  if (!mine.length) return [];
  const wanted = new Set(mine);
  const norm = normalizeCategory(candidate);
  return existing.filter((e) => {
    if (normalizeCategory(e) === norm) return true;
    const theirs = categoryTokens(e);
    return theirs.some((t) =>
      wanted.has(t) &&
      (t.length >= STRONG_TOKEN_LENGTH || mine.length === 1 || theirs.length === 1));
  });
}

/** Seed list unioned with what stores actually use, most-used first so the common
 *  choices sit at the top of the picker; seeds with no users keep their order after. */
export function buildVocabulary(usedCounts: Readonly<Record<string, number>>): string[] {
  const byNorm = new Map<string, { label: string; count: number }>();
  for (const label of SEED_CATEGORIES) byNorm.set(normalizeCategory(label), { label, count: 0 });
  for (const [raw, count] of Object.entries(usedCounts)) {
    const key = normalizeCategory(raw);
    if (!key) continue;
    const hit = byNorm.get(key);
    if (hit) hit.count += count;
    else byNorm.set(key, { label: raw.trim(), count });
  }
  return [...byNorm.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'he'))
    .map((v) => v.label);
}

export type CategoryProposal =
  | { ok: true; value: string }
  | { ok: false; reason: 'empty' | 'too-long' | 'unsafe'; message: string }
  | { ok: false; reason: 'similar'; message: string; suggestions: string[] };

/**
 * Validates a seller-proposed NEW category. `ok:false` with `reason:'similar'` is not
 * a hard refusal — the UI shows the suggestions and lets the seller add anyway if none
 * of them fit. `unsafe` IS a hard refusal.
 */
export function proposeCategory(raw: string, existing: readonly string[]): CategoryProposal {
  const value = normalizeCategory(raw);
  if (!value) return { ok: false, reason: 'empty', message: 'יש להזין שם קטגוריה.' };
  if (value.length > MAX_CATEGORY_LENGTH) {
    return { ok: false, reason: 'too-long', message: `קטגוריה מוגבלת ל-${MAX_CATEGORY_LENGTH} תווים.` };
  }
  // Same word-list every other seller-authored free-text field goes through.
  const spam = findSpamKeyword(value);
  if (spam) {
    return { ok: false, reason: 'unsafe', message: 'שם הקטגוריה כולל מילה שאינה מתאימה לקטגוריה ציבורית.' };
  }
  const suggestions = findSimilarCategories(value, existing);
  if (suggestions.length) {
    return {
      ok: false,
      reason: 'similar',
      message: 'קיימת כבר קטגוריה דומה — עדיף לבחור בה כדי שהחנות תופיע יחד עם השאר.',
      suggestions,
    };
  }
  return { ok: true, value };
}

/** Final server-side pass on a whole submitted list: normalize, drop empties and
 *  unsafe entries, de-duplicate, cap. The client picker is convenience; this is the rule. */
export function sanitizeStoreCategories(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Bound the work before inspecting anything: the accept-loop below only stops on
  // ACCEPTED entries, so a POST of a hundred thousand rejects would still walk them
  // all. Nothing past a small multiple of the cap can affect the result anyway.
  for (const item of raw.slice(0, MAX_CATEGORIES_PER_STORE * 10)) {
    const value = normalizeCategory(item);
    if (!value || value.length > MAX_CATEGORY_LENGTH) continue;
    if (findSpamKeyword(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_CATEGORIES_PER_STORE) break;
  }
  return out;
}
