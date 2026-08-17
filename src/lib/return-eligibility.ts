import { normalizeCategory } from './store-taxonomy.js';

/**
 * Which PRODUCTS the law takes out of the return right (decisions §2).
 *
 * ── The correction this file is built on (owner, 2026-08-17) ──
 * A first version keyed on the STORE's categories and was wrong in a way worth stating: *"קטגוריה
 * של חנות זה לא קטגוריה של מוצר... בתוך חנות יש קטגוריות שהן מוחרגות ולא הקטגוריה של החנות כולה"*.
 * A fashion shop is not a shop you cannot return from — it has a shelf of underwear that you cannot,
 * and racks of coats that you can. Excluding at the shop level takes the right away from most of a
 * catalogue in order to catch a corner of it, which is the larger of the two possible errors and the
 * one nobody complains about because they never learn they had the right.
 *
 * So the question is asked of the PRODUCT: its own category inside that shop, and every ancestor of
 * it. A product filed under `אופנה › הלבשה תחתונה` is excluded; its sibling under `אופנה › מעילים`
 * is not.
 *
 * ── Why it matches WORDS rather than an id ──
 * A store's category tree is free text its seller typed. There is no shared vocabulary to key on and
 * there deliberately will not be one — asking every seller to map their shelves onto a platform
 * taxonomy is exactly the entry barrier this project refuses (`feedback_seller_form_burden`). So the
 * terms below are matched against the names on the product's own path, normalised the same way
 * `store-taxonomy.ts` normalises everything else.
 *
 * That makes the list a JUDGEMENT about words, and it is written to fail SAFE: a seller who calls
 * the shelf something the list does not know keeps the ordinary return right, which is the law's
 * default and the error that can be corrected later. The reverse — a word that over-matches and
 * silently removes a right — cannot be.
 *
 * ── ⚠️ The mapping is question 5 of `docs/returns-lawyer-brief.md` and is UNANSWERED ──
 * תקנה 6 names goods; this names Hebrew shelf labels. Where the two meet needs confirming, and until
 * it is confirmed the list stays short and obvious rather than clever.
 */
export const NON_RETURNABLE_TERMS: readonly string[] = [
  // הלבשה תחתונה ובגדי ים — named by the regulation.
  'הלבשה תחתונה',
  'תחתונים',
  'תחתוני',
  'הלבשה אינטימית',
  'בגדי ים',
  'בגד ים',
  'בגדי-ים',
  // מוצרי מזון, תוספי תזונה ותרופות — also named by it.
  'מזון',
  'מאכל',
  'תוספי תזונה',
  'ויטמינים',
  'תרופות',
  // Food by another name, on the shelves where it actually appears.
  'מזון לתינוק',
  'מזון לחיות',
  'אוכל לחיות',
];

const TERMS = NON_RETURNABLE_TERMS.map((t) => normalizeCategory(t));

/**
 * Is this product returnable, given the category path it sits under?
 *
 * `path` is the product's own category and its ancestors — `categoryPath()` builds it, and a caller
 * may pass the names in any form. A product filed nowhere is returnable: absence is not evidence,
 * and the header explains which direction the doubt has to fall.
 *
 * Substring rather than equality, because a seller writes `בגדי ים לנשים`, not `בגדי ים`. That
 * widens the match on purpose — and it is why the term list is short: every entry has to be a phrase
 * that cannot appear innocently inside an unrelated shelf name.
 */
export function isProductReturnable(path: readonly string[] | string | null | undefined): boolean {
  if (!path) return true;
  const names = Array.isArray(path) ? path : String(path).split('›');
  if (!names.length) return true;
  const haystack = names.map((n) => normalizeCategory(String(n))).join(' | ');
  return !TERMS.some((term) => haystack.includes(term));
}

/**
 * The one line a product page shows when it may NOT be returned. Null when it may.
 *
 * Nothing is said in the ordinary case: a note reading "this can be returned" on every other product
 * is noise, and the policy page is where the rule lives.
 */
export function nonReturnableNotice(path: readonly string[] | string | null | undefined): string | null {
  return isProductReturnable(path)
    ? null
    : 'לפי תקנות הגנת הצרכן, מוצר מסוג זה לא ניתן להחזרה אחרי הרכישה.';
}
