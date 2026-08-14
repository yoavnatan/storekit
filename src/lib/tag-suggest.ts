// Zero-touch tag SUGGESTION — auto-discover search tags for a product from the
// text it already has (its category path, name and description), so the seller
// doesn't have to invent keywords. This only *proposes*: the seller clicks a
// suggestion to accept it, or ignores it, and can still type their own (the
// manual chip editor in dashboard/products.ts is unchanged). Nothing here is
// ever saved automatically — a suggestion becomes a real tag only on an
// explicit click. Tags feed the site/product search (site-search.ts,
// product-listing.ts), so better default coverage = better discoverability.
//
// Pure/isomorphic (no node:fs) — same class as audience-infer.ts. It runs in
// the browser bundle (the dashboard product editor imports it live so the
// suggestions update as the seller types) and could also run SSR.

// A tag is only useful for search if it's a real content word. These are the
// glue words (Hebrew + English) that carry no product meaning — dropped so a
// name like "כיסא עץ לסלון" suggests כיסא / עץ / סלון, not ל / ה.
const STOPWORDS = new Set<string>([
  // Hebrew
  'של', 'עם', 'על', 'את', 'זה', 'זו', 'גם', 'כמו', 'מאוד', 'יותר', 'הכי',
  'אבל', 'או', 'אם', 'כי', 'רק', 'עוד', 'כל', 'לא', 'כן', 'יש', 'אין',
  'הוא', 'היא', 'הם', 'הן', 'אני', 'אתה', 'את', 'אנחנו', 'בין', 'לפי',
  'אצל', 'תוך', 'עד', 'מן', 'כדי', 'בשביל', 'ללא', 'בלי', 'לכל', 'לגבי',
  // English
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'by', 'at', 'from', 'as', 'is', 'are', 'be', 'this', 'that', 'it', 'its',
  'your', 'our', 'you', 'we', 'not', 'no', 'all', 'any', 'new', 'per',
]);

export interface TagSuggestInput {
  /** Product name — the strongest word source after the category path. */
  name?: string | null;
  /** Free-text description — mined for extra attribute words (material/colour/feature). */
  description?: string | null;
  /** Category path, either " › "-joined (as the picker renders it) or already split. */
  categoryPath?: string | string[] | null;
  /** Variant option values (colours, materials, styles) — a flat list across all
   *  dimensions. Pure size codes (S/M/L/42/One Size) are filtered out as noise. */
  variantValues?: string[];
  /** Tags the product already has — never re-suggested (case-insensitive). */
  existingTags?: string[];
  /** Max suggestions returned (default 8). */
  max?: number;
}

// A "word" for tag purposes: a run of Hebrew or Latin letters (with an inner
// apostrophe/hyphen allowed, so צ'ח / t-shirt survive) plus digits. Everything
// else (punctuation, symbols, standalone measurement marks) is a separator.
const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

// A token earns a tag slot only if it's a meaningful content word: not a
// stopword, not a bare number/measurement, and long enough to mean something
// (Latin needs 3+ letters — "xl"/"cm" are noise; Hebrew words are dense so 2+).
function isMeaningfulWord(word: string): boolean {
  const w = normalize(word);
  if (!w || STOPWORDS.has(w)) return false;
  if (/^\d+$/.test(w)) return false;          // pure number
  if (/^\d/.test(w)) return false;            // 4xl, 20cm — a measurement, not a topic
  const isLatin = /^[a-z]/.test(w);
  return isLatin ? w.length >= 3 : w.length >= 2;
}

// A variant value is a good tag when it names an attribute a buyer would search
// (colour/material/style) — but a size code carries no search meaning, so those
// are rejected: single/double letter sizes (S/M/L/XL/XXL), OS/one-size/free-size,
// and anything starting with a digit (numeric sizes 38/42, measurements 20cm).
//
// This is NOT the rule for what search matches — that is
// `product-search-text.ts#isSearchableVariantValue`, which reads `variants` at the source and is
// wider on purpose (it keeps `XL` and `50ml`, which are things a shopper types even though they
// are not topics a product is ABOUT). This rule stays narrow because its output is a stored,
// seller-editable tag that also becomes JSON-LD `keywords`. Since 0027 search no longer depends on
// this copy, so narrowing it further costs nothing — but widening it would put "XL" in a keywords
// list, which is what it exists to prevent.
const SIZE_VALUE_RE = /^(?:x*s|x*l|xxl|m|os|one[\s-]?size|free[\s-]?size)$/i;

function isMeaningfulValue(value: string): boolean {
  const v = normalize(value);
  if (!v || !/\p{L}/u.test(v)) return false;   // empty or no letters (pure number/symbol)
  if (/^\d/.test(v)) return false;             // numeric size / measurement
  return !SIZE_VALUE_RE.test(v);
}

function splitCategoryPath(path: TagSuggestInput['categoryPath']): string[] {
  if (!path) return [];
  const segments = Array.isArray(path) ? path : path.split(/[›>\/|]/);
  return segments.map((s) => s.trim()).filter(Boolean);
}

function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.match(WORD_RE) ?? [];
}

// Curated product-attribute lexicon — the ONLY words worth pulling out of a
// free-text description. A description is mostly filler ("נוח", "מושלם",
// "איכותי", "מתאים"); surfacing every content word as a tag is noise, not
// intelligence. Instead we recognise the terms a buyer actually searches by —
// material / colour / style / feature / occasion — and ignore the rest. This is
// the deliberate heuristic stand-in for the semantic search planned for the DB
// phase (CONTEXTUAL_SEARCH_STRATEGY.md); it's meant to grow over time.
const ATTRIBUTE_WORDS = new Set<string>([
  // Materials
  'עור', 'כותנה', 'פשתן', 'צמר', 'קשמיר', 'משי', 'פוליאסטר', 'ניילון', 'גינס', 'דנים',
  'עץ', 'אלון', 'אורן', 'מהגוני', 'במבוק', 'ראטן', 'קש', 'מתכת', 'נירוסטה', 'פלדה',
  'אלומיניום', 'ברזל', 'נחושת', 'פליז', 'זהב', 'כסף', 'פלטינה', 'זכוכית', 'קריסטל',
  'קרמיקה', 'חרסינה', 'פורצלן', 'אבן', 'שיש', 'גרניט', 'בטון', 'פלסטיק', 'אקריליק',
  'גומי', 'סיליקון', 'קנבס', 'זמש', 'קטיפה', 'לבד', 'פרווה', 'חרוזים',
  'leather', 'cotton', 'linen', 'wool', 'cashmere', 'silk', 'polyester', 'nylon',
  'denim', 'wood', 'oak', 'bamboo', 'rattan', 'metal', 'steel', 'stainless',
  'aluminum', 'aluminium', 'copper', 'brass', 'gold', 'silver', 'glass', 'crystal',
  'ceramic', 'porcelain', 'marble', 'granite', 'concrete', 'plastic', 'acrylic',
  'rubber', 'silicone', 'canvas', 'suede', 'velvet',
  // Colours
  'שחור', 'לבן', 'אפור', 'אדום', 'כחול', 'ירוק', 'צהוב', 'כתום', 'סגול', 'ורוד',
  'חום', 'בז', 'טורקיז', 'בורדו', 'חאקי', 'שמנת', 'קרם', 'נייבי', 'זהוב', 'כספי',
  'black', 'white', 'gray', 'grey', 'red', 'blue', 'green', 'yellow', 'orange',
  'purple', 'pink', 'brown', 'beige', 'navy', 'turquoise',
  // Styles
  'וינטג', 'רטרו', 'מודרני', 'קלאסי', 'מינימליסטי', 'בוהו', 'אלגנטי', 'יוקרתי',
  'כפרי', 'תעשייתי', 'סקנדינבי', 'אתני', 'רומנטי', 'ספורטיבי', 'קלאסית',
  'vintage', 'retro', 'modern', 'classic', 'minimalist', 'boho', 'elegant',
  'luxury', 'rustic', 'industrial', 'scandinavian', 'casual',
  // Features
  'אלחוטי', 'נטען', 'נייד', 'מתקפל', 'עמיד', 'אורגני', 'טבעוני', 'אקולוגי', 'ידני',
  'היפואלרגני', 'טבעי', 'מבודד', 'חכם', 'מתכוונן', 'מרובד',
  'wireless', 'rechargeable', 'portable', 'foldable', 'waterproof', 'organic',
  'vegan', 'handmade', 'natural', 'smart', 'adjustable', 'eco',
  // Occasions / use
  'חתונה', 'אירוע', 'ערב', 'יומיומי', 'קיץ', 'חורף', 'אביב', 'סתיו', 'חוף', 'משרד',
  'מטבח', 'סלון', 'גינה', 'מתנה', 'ספורט', 'ריצה', 'יוגה', 'טיולים',
  'wedding', 'party', 'summer', 'winter', 'beach', 'office', 'kitchen', 'gift',
  'sport', 'running', 'yoga', 'outdoor',
]);

// Multi-word attributes checked as substrings so the phrase beats its parts
// ("עבודת יד", not a stray "יד"). Normalized (lowercase) to match the haystack.
const ATTRIBUTE_PHRASES = [
  'עבודת יד', 'עמיד למים', 'דמוי עור', 'עץ מלא', 'נגד החלקה', 'בעבודת יד',
  'water resistant', 'eco friendly', 'hand made', 'stainless steel',
];

// Strip one attached Hebrew prefix letter (מ/ב/ה/ו/ל/ש/כ) so "מעץ" / "מעור"
// still matches the material "עץ" / "עור". Only ever tested against the curated
// lexicon, so a wrong strip can't invent a tag — it just fails to match. The
// full word is checked BEFORE stripping, so lexicon entries that legitimately
// start with one of these letters ("משי", "לבן", "כחול") match as-is.
const HEB_PREFIX_RE = /^[מבהולשכ]/;

// Recognized attribute terms appearing in the given text, in reading order,
// phrases first. Returns normalized (lowercase) forms; the caller de-dupes.
function attributeHits(text: string): string[] {
  const hits: string[] = [];
  const hay = normalize(text);
  if (!hay) return hits;
  for (const phrase of ATTRIBUTE_PHRASES) {
    if (hay.includes(phrase)) hits.push(phrase);
  }
  for (const word of tokenize(text)) {
    const w = normalize(word);
    if (ATTRIBUTE_WORDS.has(w)) { hits.push(w); continue; }
    const stripped = HEB_PREFIX_RE.test(w) ? w.slice(1) : w;
    if (stripped !== w && ATTRIBUTE_WORDS.has(stripped)) hits.push(stripped);
  }
  return hits;
}

/**
 * Suggest search tags for a product from its own text, ranked by usefulness.
 *
 * Ranking (highest first): whole category-path segments (already curated,
 * multi-word phrases like "נעלי ספורט") → words from the name → words from the
 * description (only fill remaining slots, and only words that recur or are long
 * enough to matter). Case-insensitive de-dupe, and anything already in
 * `existingTags` is skipped. Returns display-cased tokens (as first seen),
 * capped at `max`.
 */
export function suggestTags(input: TagSuggestInput): string[] {
  const max = input.max ?? 8;
  const taken = new Set((input.existingTags ?? []).map(normalize));
  const ordered: string[] = [];      // final tags in display casing, ranked
  const seen = new Set<string>();    // normalized, for de-dupe across all sources

  const add = (raw: string): void => {
    const display = raw.trim();
    const key = normalize(display);
    if (!display || seen.has(key) || taken.has(key)) return;
    seen.add(key);
    ordered.push(display);
  };

  // Tier 1 — category segments: curated, high-signal, kept as whole phrases.
  for (const seg of splitCategoryPath(input.categoryPath)) add(seg);

  // Tier 2 — name words: the seller's own naming, one content word at a time.
  for (const word of tokenize(input.name)) {
    if (isMeaningfulWord(word)) add(word);
  }

  // Tier 3 — variant values: concrete attributes (a red/leather/oak option) a
  // buyer often searches by. Kept whole (a multi-word "כחול כהה" stays one tag),
  // size codes filtered. Sits above the description — an option the seller
  // deliberately created is higher-signal than a word in the blurb.
  for (const value of input.variantValues ?? []) {
    if (isMeaningfulValue(value)) add(value.trim());
  }

  // Tier 4 — recognized attribute keywords in the name + description (material /
  // colour / style / feature / occasion). NOT every content word: a description
  // is mostly filler, so only curated attribute terms — the words a buyer
  // actually searches by — are surfaced. Phrases already come before their parts.
  for (const hit of attributeHits(`${input.name ?? ''} ${input.description ?? ''}`)) add(hit);

  return ordered.slice(0, max);
}

/**
 * The high-confidence subset of suggestTags — category-path segments + variant
 * values ONLY, never free-text name/description words. These come from
 * structured, curated inputs (a category the seller picked, options they
 * deliberately created), so they're safe to apply to a product AUTOMATICALLY on
 * save; the noisier name/description words stay click-to-add suggestions. Skips
 * anything already in `existingTags` (the seller's own tags) so it only ever
 * ADDS, and caps the count so a product with many variant options can't explode
 * the tag list.
 */
export function deriveAutoTags(
  input: Pick<TagSuggestInput, 'categoryPath' | 'variantValues' | 'existingTags'> & { max?: number },
): string[] {
  const max = input.max ?? 15;
  const taken = new Set((input.existingTags ?? []).map(normalize));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const display = raw.trim();
    const key = normalize(display);
    if (!display || seen.has(key) || taken.has(key)) return;
    seen.add(key);
    out.push(display);
  };
  for (const seg of splitCategoryPath(input.categoryPath)) add(seg);
  for (const value of input.variantValues ?? []) {
    if (isMeaningfulValue(value)) add(value.trim());
  }
  return out.slice(0, max);
}
