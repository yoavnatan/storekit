import { normalizeCategory } from './store-taxonomy.js';

/**
 * Which products the LAW takes out of the return right — held by the platform, never asked of a
 * seller (decisions §2).
 *
 * ── Why a platform list and not a per-product flag ──
 * The owner's answer in the decision game, and the reasoning is his standing rule about seller
 * forms: a checkbox on every product is a field a seller has to understand before they can answer
 * it, and the ones who would tick it wrongly are exactly the ones the rule exists to catch. The
 * exclusions come from תקנה 6 — they are a property of what the thing IS, not of what a shopkeeper
 * thinks about it — so the platform decides once and every shop inherits it.
 *
 * ── ⚠️ This list is a MAPPING, and the mapping is the part a lawyer has to confirm ──
 * The regulation names goods ("מוצרי מזון", "הלבשה תחתונה", "טובין שיוצרו במיוחד עבור הצרכן"); this
 * file names the platform's own 20-word category vocabulary (`SEED_CATEGORIES`). Those are not the
 * same sentence, and where they meet is a judgement:
 *
 *   · **מזון** — the regulation's own word. The clearest of them.
 *   · **לתינוק** — covers formula and baby food, which are food, alongside a great deal that is not.
 *     Excluded WHOLE, because the alternative is asking a seller to split their own shelf and the
 *     cost of being wrong falls on a parent holding a tin nobody will take back.
 *   · **חיות מחמד** — pet food, same reasoning.
 *
 * Everything else in the vocabulary stays returnable, INCLUDING `אופנה`: underwear and swimwear are
 * excluded by the regulation and "fashion" is overwhelmingly not either, so excluding the category
 * would remove the right from most of a shop to catch a little of it. That case needs the per-item
 * answer this list deliberately does not ask for — it is question 5 in `docs/returns-lawyer-brief.md`
 * and is left OPEN rather than guessed, because guessing wide costs buyers a right they have and
 * guessing narrow costs a seller goods they cannot resell.
 *
 * Until that answer arrives this file is deliberately SHORT. A list that over-excludes is a list
 * that quietly denies people something the law gives them, which is the worse of the two errors and
 * the one nobody would report.
 */
export const NON_RETURNABLE_CATEGORIES: readonly string[] = [
  'מזון',
  'לתינוק',
  'חיות מחמד',
];

const EXCLUDED = new Set(NON_RETURNABLE_CATEGORIES.map((c) => normalizeCategory(c)));

/**
 * May this product be returned at all?
 *
 * Takes the product's categories as the store stores them — free text a seller may have typed, which
 * is why it normalises before comparing rather than matching strings. A product with no category at
 * all is returnable: absence is not evidence, and the direction of that default is the same one the
 * header argues for.
 */
export function isReturnable(categories: readonly string[] | null | undefined): boolean {
  if (!categories?.length) return true;
  return !categories.some((c) => EXCLUDED.has(normalizeCategory(c)));
}

/** The one line a product page shows when it is NOT returnable. Null when it is — a page that says
 *  "this CAN be returned" on every other product is noise, and the policy page carries the rule. */
export function nonReturnableNotice(categories: readonly string[] | null | undefined): string | null {
  return isReturnable(categories)
    ? null
    : 'על פי תקנות הגנת הצרכן, מוצר מסוג זה אינו ניתן להחזרה.';
}
