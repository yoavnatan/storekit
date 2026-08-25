/**
 * PayMe's merchant category, derived from the store's own — so the seller never sees the field.
 *
 * ── The problem ──
 * `create-seller` requires `seller_business_type`, and PayMe's list is a PRIVATE numbering from
 * 10000 up, enumerated by trade (`10009 מאפיה`, `10200 הלבשה כללית`) — **not** ISO 18245. It runs to
 * hundreds of rows, most of them a size or a sub-speciality of another row. Putting that list in
 * front of a seller is precisely the rubric `feedback_seller_form_burden` forbids: he cannot answer
 * "am I a type-2 footwear shop or a type-3 one" and neither can we.
 *
 * `merchant-kyc.ts` therefore treated the category as a required field with no default — after the
 * old `5999` fallback turned out to be an ISO code PayMe do not recognise at all. This module is the
 * answer that was open there and in GO_LIVE §3.1.2: **derive it from the categories the seller
 * already picked for his shop** (owner, 2026-08-23), and ask only when nothing maps.
 *
 * ── The rules of the mapping ──
 * · **The BROADEST row of each trade, never a sub-row.** PayMe's list splits most trades by shop
 *   size or price bracket (`הנעלה-חנויות סוג 1…4`, `תכשיטים ושעונים-חנויות יוקרתיות`), and those are
 *   distinctions about a business we do not hold and would be guessing at. The parent row is the
 *   true statement.
 * · **First match wins, in the seller's own order.** `Store.categories` is at most three and he
 *   ordered them; the first is what the shop mostly is.
 * · **A category with no honest match is simply absent.** `כלבו` — a department store — has no row
 *   in their list at all: every candidate is "general" WITHIN a trade, never across trades. So it
 *   maps to nothing and the seller is asked, which is the one case the form still has a field for.
 *   Inventing a row here is how the `5999` mistake happened.
 *
 * Pure: takes the categories, returns a code or null. No DB, no PayMe call.
 */

/** Our seed vocabulary → PayMe's code. Hebrew keys, because the Hebrew string IS the identity of a
 *  store category everywhere in this codebase (`store-taxonomy.ts`). Every code is quoted with the
 *  row it came from so the next reader can check it against their list rather than trust this file. */
const PAYME_CATEGORY_BY_STORE_CATEGORY: Readonly<Record<string, string>> = {
  'אופנה':      '10200', // הלבשה כללית
  'בגדים':      '10200', // הלבשה כללית
  'הנעלה':      '10407', // הנעלה
  'תיקים':      '10140', // ארנקים ותיקים
  'תכשיטים':    '10544', // תכשיטים ושעונים
  'טיפוח':      '10552', // תמרוקיות
  'אלקטרוניקה': '10328', // חשמל ואלקטרוניקה
  'מחשבים':     '10342', // מחשבים
  'סלולר':      '10267', // טלפונים סלולריים
  'אביזרים':    '10114', // אביזרי אופנה
  'לבית':       '10276', // כלי בית ומטבח
  'מטבח':       '10276', // כלי בית ומטבח — the same trade in their list, and splitting it would be ours to invent
  'ריהוט':      '10490', // רהיטים
  'ספורט':      '10341', // ספורט ומחנאות
  'מזון':       '10428', // סופרמרקטים
  'פרחים':      '10465', // פרחים ועציצים
  'צמחים':      '10000', // משתלות
  'צעצועים':    '10477', // צעצועים
  'לתינוק':     '10467', // ציוד לתינוק
  'חיות מחמד':  '10073', // חיות
  'ספרים':      '10032', // ספרים
  'כלי עבודה':  '10295', // כלי עבודה
  'רכב':        '10021', // אביזרי רכב
  'מתנות':      '10337', // מזכרות מתנות חפצי חן
  // 'כלבו' is deliberately absent — see the module header. There is no cross-trade row.
};

/**
 * The PayMe code for a shop, or `null` when nothing in its categories maps.
 *
 * `null` is a real answer and the reason this returns one: the seller is then asked, once, on the
 * clearing form. A default would be a category their system may not recognise, and the consequence
 * of that is a merchant they cannot underwrite — discovered by the seller as an account that never
 * gets approved.
 */
export function paymeCategoryForStore(storeCategories: readonly string[] | undefined): string | null {
  for (const category of storeCategories ?? []) {
    const code = PAYME_CATEGORY_BY_STORE_CATEGORY[category.trim()];
    if (code) return code;
  }
  return null;
}

/** Is this one of the codes we derive? Used by the form to decide whether to show the field at all
 *  — and by `tests/merchant-category.test.ts`, which checks every mapped code really appears in
 *  PayMe's own captured list rather than trusting the comments above. */
export function isDerivedPaymeCategory(code: string): boolean {
  return Object.values(PAYME_CATEGORY_BY_STORE_CATEGORY).includes(code);
}

/** Every store category we can answer for. Exported so the test can assert this covers the seed
 *  vocabulary minus the deliberate exception, rather than the list quietly rotting when a category
 *  is added to `store-taxonomy.ts`. */
export const MAPPED_STORE_CATEGORIES: readonly string[] = Object.keys(PAYME_CATEGORY_BY_STORE_CATEGORY);

/**
 * The fallback the clearing form offers when nothing derived — **our own categories, not PayMe's
 * codes** (owner asked what happens then, 2026-08-24).
 *
 * A store's categories are FREE TEXT (`store-taxonomy.ts#sanitizeStoreCategories` accepts any short
 * string, and the picker's vocabulary is a suggestion rather than a whitelist), so a seller who
 * typed *"ציוד ספורט ימי"* maps to nothing — and that is an ordinary case, not the rare one. The
 * field used to be a five-digit numeric input, which asked him for a code from a list he has never
 * seen and could not find: the exact rubric `feedback_seller_form_burden` forbids.
 *
 * So he answers the question he can answer — which of these does your shop sell — and the code is
 * ours to look up. Sorted by the Hebrew label, because that is what he is reading.
 */
export const MERCHANT_CATEGORY_OPTIONS: readonly { label: string; code: string }[] =
  Object.entries(PAYME_CATEGORY_BY_STORE_CATEGORY)
    .map(([label, code]) => ({ label, code }))
    .sort((a, b) => a.label.localeCompare(b.label, 'he'));
