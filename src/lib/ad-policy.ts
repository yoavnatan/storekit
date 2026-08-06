/**
 * What we must never SUBMIT to Google Merchant Center or Meta Commerce — as distinct from what a
 * seller may sell.
 *
 * **Why the two are different questions, and why only one of them is code's to answer.** Which
 * categories this marketplace trades in at all is the owner's decision: it carries Israeli legal
 * exposure and is a business position. But the ad networks publish their OWN prohibited-content
 * policies, and the platform's account is bound by them regardless of what anyone here decides. So
 * this module answers only the second question — *may this product be sent to an ad network* — and
 * it never touches the storefront. A product matched here keeps selling, keeps its page, keeps its
 * SEO; it simply does not enter the feed.
 *
 * **Why that distinction is load-bearing (2026-08-06).** The platform advertises every seller from
 * ONE Merchant Center, ONE Catalog and ONE Pixel — that is what lets a seller be advertised without
 * registering anywhere (memory `project_ad_platform_account_risk`). Both networks suspend the
 * ACCOUNT, not the item, for prohibited content. So one seller listing a vape kit does not lose one
 * listing: it takes every store on the platform off Google and Meta at once, for as long as the
 * appeal takes. `spam-filter.ts` next door does not cover this — it catches keyword STUFFING
 * ("קזינו", "ויאגרה"), and a prohibited product described in ordinary language passes it untouched.
 *
 * **The list is deliberately NARROW, and that is a design decision rather than a gap.** Excluding a
 * legitimate product from the feed is a real harm too — silent, and paid for by the seller in lost
 * reach. Google prohibits knives *designed as weapons*, not kitchen knives; "אקדח" is a gun and
 * also a glue gun and a heat gun. So every entry here has to be unambiguous ON ITS OWN, which in
 * practice means a phrase rather than a word. Anything requiring judgement — alcohol, supplements,
 * medical devices, anything that depends on the product's real use rather than its name — is
 * deliberately absent and is part of the owner's own list (GO_LIVE, "מוצרים אסורים לפרסום").
 * **This is a floor, not a substitute for that decision.**
 *
 * Same matching machinery as `spam-filter.ts`, for the same reason: JS `\b` is defined off `\w`,
 * which contains no Hebrew at all, so a Hebrew term cannot be bounded by it.
 */
import type { StoreProduct } from './store-products.js';

/**
 * Prohibited by BOTH networks' published policies, and unambiguous in Hebrew or English.
 *
 * Grouped by the policy each comes from so a future edit can be checked against the source rather
 * than against taste. Every entry was tested against the collision that would have made it wrong.
 */
const AD_PROHIBITED_TERMS: readonly string[] = [
  // ── Tobacco and vaping (Google: Prohibited; Meta: Prohibited) ────────────────
  // "טבק" alone would hit "טבק לנרגילה" and also "ריח טבק" in perfume copy — but perfume is
  // exactly the ambiguous case, so only the unmistakable product names are listed.
  'סיגריה אלקטרונית', 'סיגריות אלקטרוניות', 'סיגריות', 'נוזל לסיגריה אלקטרונית',
  'e-cigarette', 'e-cigarettes', 'electronic cigarette', 'vape', 'vaping', 'vape pen', 'e-liquid',
  'nicotine pouches',

  // ── Recreational drugs and paraphernalia (Google: Prohibited; Meta: Prohibited) ──
  'קנאביס', 'מריחואנה', 'חשיש', 'בונג',
  'cannabis', 'marijuana', 'cbd oil', 'bong', 'grinder for weed',

  // ── Weapons, ammunition, explosives (Google: Prohibited; Meta: Prohibited) ───
  // NOT the bare "אקדח" and NOT the bare "רובה": in Hebrew both are ordinary hardware — אקדח
  // סיכות (staple gun), אקדח מסמרים / רובה מסמרים (nail gun), אקדח דבק, אקדח חום, אקדח סיליקון,
  // אקדח צבע, אקדח שמנון, אקדח מים. The owner found the first two by inspection on 2026-08-07;
  // all of them are pinned as MUST-NOT-match in tests/ad-policy.test.ts. Nor "סכין" — kitchen
  // knives are the marketplace's ordinary business. Only what cannot be anything else.
  'תת מקלע', 'תת-מקלע', 'רובה ציד', 'תחמושת', 'כדורי רובה', 'אגרופן', 'אלת הלם',
  'firearm', 'firearms', 'ammunition', 'silencer', 'brass knuckles', 'stun gun', 'pepper spray',
  'זיקוקים', 'חומר נפץ', 'explosives',

  // ── Counterfeit goods (Google: Prohibited; Meta: Prohibited) ────────────────
  // The seller SAYING it is a copy is the unambiguous signal; a real counterfeit never says so,
  // and detecting that is not a blocklist's job.
  'חיקוי מותג', 'העתק מותג', 'רפליקה של', 'שעון חיקוי', 'תיק חיקוי',
  'replica watch', 'replica bag', 'counterfeit', 'first copy',

  // ── Adult products (Google: Prohibited in Shopping; Meta: Prohibited) ────────
  'צעצועי מין', 'ויברטור', 'sex toy', 'sex toys', 'vibrator', 'adult toys',
];

const WORD_CHAR = 'A-Za-z0-9\\u0590-\\u05FF';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lookaround rather than `\b`, so a Hebrew term is bounded correctly — see spam-filter.ts. */
function termRegex(term: string): RegExp {
  return new RegExp(`(?<![${WORD_CHAR}])${escapeRegex(term)}(?![${WORD_CHAR}])`, 'iu');
}

/**
 * The first prohibited term this product's own text matches, or null when it is clean.
 *
 * Reads the fields a network actually receives — title, description, tags, brand — because the
 * question is what WE would be submitting, not what the seller privately meant. Returns the term so
 * the seller can be told which word triggered it: an exclusion he cannot see the cause of is the
 * silent-rejection failure this whole area exists to end.
 */
export function adPolicyViolation(product: Pick<StoreProduct, 'name' | 'description' | 'tags' | 'brand'>): string | null {
  const combined = [product.name, product.description, product.brand, ...(product.tags ?? [])]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!combined) return null;
  for (const term of AD_PROHIBITED_TERMS) {
    if (termRegex(term).test(combined)) return term;
  }
  return null;
}

/** Exported for the guard test, which asserts the list stays unambiguous rather than growing by feel. */
export const AD_PROHIBITED_TERM_COUNT = AD_PROHIBITED_TERMS.length;
