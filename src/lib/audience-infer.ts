// Keyword-based inference of a product's likely target gender from its own
// text — the category path it sits under (strongest signal), its name, and its
// tags. Heuristic, same class as spam-filter.ts's word matching: it only
// *suggests* a value to pre-fill the campaign form so a seller who already
// categorized a product under "גברים"/"Men" doesn't type the audience a second
// time (no duplicate input). The seller can always override in the form, and a
// tie or no signal returns null (→ "all", let the ad platform auto-target).
//
// Pure/isomorphic (no node:fs), so both SSR (dashboard/admin frontmatter and
// the future catalog feed) and any browser-bundled caller can import it.
//
// THE TRAP THIS MODULE EXISTS INSIDE (moved here from AI_INSTRUCTIONS.md
// 2026-08-03, because it is only ever needed by whoever edits this file or the
// campaign form it fills): gender and age_group describe **who the product is
// FOR** — they are Merchant/Catalog *feed attributes* — and NOT who the ad is
// shown to. A baby-clothes ad targets adult parents. So never turn either of
// these into a *viewer* age band: a version that derived 18-24 / 25-34 … from
// the product was tried and replaced the same day. What the seller sees is a
// pre-filled, overridable suggestion about the product; the ad platform decides
// who actually sees the ad.

// Each gender is one regex. Latin words carry \b boundaries — that alone stops
// the classic "men" ⊂ "women" / "man" ⊂ "woman" collision. Hebrew has no \b
// (Hebrew letters aren't \w), so masculine forms use `גבר(?!ת)`: it matches
// גבר / גברים / גברי / לגבר(ים) — every "man" form — but NOT גברת / לגברת
// (lady), which would otherwise be a false men-hit since גבר ⊂ גברת. Substring
// roots (נשים, גברת, בנות, ...) already cover their ל/ה-prefixed forms.
const MEN_RE = /\b(?:men|man|mens|male|boys?|gentlemen)\b|גבר(?!ת)|בנים/i;
const WOMEN_RE = /\b(?:women|woman|womens|female|lady|ladies|girls?)\b|נשים|נשית|אישה|אשה|גברת|בנות/i;

/**
 * Infer a product's likely target gender from its category path / name / tags.
 * Presence-based (not a per-word count, which overlapping Hebrew forms would
 * skew): if only one gender's signal appears, return it.
 * @returns 'men' | 'women', or null when there's no signal or BOTH genders
 *          appear (ambiguous/unisex) — the caller should treat null as "all".
 */
export function inferAudienceGender(texts: (string | undefined | null)[]): 'women' | 'men' | null {
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  if (!hay) return null;
  const men = MEN_RE.test(hay);
  const women = WOMEN_RE.test(hay);
  if (men && !women) return 'men';
  if (women && !men) return 'women';
  return null; // neither, or both (ambiguous)
}

// age_group is the standard Google Merchant / Meta Catalog product attribute —
// "who the product is FOR", NOT who the ad is shown to (a baby-clothes ad is
// shown to adult parents). So this is derived from the product's own text, same
// as gender, and only distinguishes the age-scoped buckets; most products carry
// no age signal and stay null (→ "all"). Infant is checked before kids because
// it's the more specific bucket ("תינוקות ופעוטות" would otherwise read as kids).
const INFANT_RE = /\b(?:baby|babies|infant|newborn|toddler)\b|תינוק|בייבי|פעוט/i;
const KIDS_RE = /\b(?:kids?|children|child|youth|teens?|junior)\b|ילד|נוער/i;

/**
 * Infer a product's target age group from its category path / name / tags.
 * @returns 'infant' | 'kids' | 'adult', or null when there's no age signal
 *          (the caller should treat null as "all" — most products are adult and
 *          don't need an explicit band; the ad platform infers the buyer's age).
 */
export function inferAgeGroup(texts: (string | undefined | null)[]): 'infant' | 'kids' | 'adult' | null {
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  if (!hay) return null;
  if (INFANT_RE.test(hay)) return 'infant';
  if (KIDS_RE.test(hay)) return 'kids';
  return null;
}
