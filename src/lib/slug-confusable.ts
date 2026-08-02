// Reading a slug the way a PERSON does, so a platform route cannot be impersonated by spelling.
//
// Opening slugs to non-Latin letters (url-base.ts#toSlug, 2026-08-02) let in a class plain a-z
// never had: two DIFFERENT strings that render identically. Cyrillic а (U+0430) and Latin a
// (U+0061) are separate code points no font distinguishes, so `аdmin` and `admin` are two distinct
// strings that look the same in an address bar and in a Google result.
//
// **What this module does NOT do, decided by the owner 2026-08-02:** it does not police one seller
// against another, and it does not restrict which scripts a seller may mix. `shop-ישראל` and
// `gal-gallery` are normal, useful Israeli slugs, and a rule against mixing scripts would cost
// every one of them to prevent a rarer harm. Seller-versus-seller impersonation is handled where
// deception is actually judged — a report and a rule violation, with the admin block already
// built — not by a character filter that cannot tell a lookalike from a legitimate brand.
//
// What remains is the part no report can undo in time and no seller has a legitimate claim to: the
// platform's own reserved paths (`admin`, `api`, `checkout`…). Folding the known Latin-confusable
// letters onto their twin gives a SKELETON, and `stores.ts#isReservedSlug` tests the skeleton
// instead of the raw string. That covers every lookalike spelling of a reserved word — including
// ones nobody has thought to enumerate — without a hand-maintained list of variations.

/**
 * Cyrillic and Greek letters rendered identically (or near enough to deceive) by the fonts a
 * browser actually uses, mapped to the Latin letter they imitate.
 *
 * Deliberately a short, hand-checked list rather than the full Unicode confusables table: every
 * entry is a pair a reader cannot tell apart at address-bar size, which is the only thing the
 * skeleton is for. A near-miss a careful reader could distinguish belongs in neither.
 *
 * Hebrew and Arabic have no entries and need none — they resemble no Latin letter, so their
 * skeleton is themselves.
 */
const CONFUSABLE_TO_LATIN: Readonly<Record<string, string>> = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'с': 'c', 'е': 'e', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'к': 'k',
  'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'т': 't', 'у': 'y', 'х': 'x', 'ї': 'i',
  'ԁ': 'd', 'ԍ': 'g', 'ѡ': 'w', 'ц': 'u', 'ғ': 'f',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'ζ': 'z', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v',
  'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'γ': 'y', 'σ': 'o', 'µ': 'u',
};

/**
 * The slug reduced to what a reader SEES: every known confusable folded onto its Latin twin.
 *
 * Iterated by code point (`for…of`), not by index — a slug may hold astral letters, and a code
 * unit is not a character.
 */
export function confusableSkeleton(slug: string): string {
  let out = '';
  for (const ch of slug) out += CONFUSABLE_TO_LATIN[ch] ?? ch;
  return out;
}
