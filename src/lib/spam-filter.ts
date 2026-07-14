// Blocks the platform's single highest-leverage negative-SEO risk: a seller
// stuffing a product/category name or tag list with spam/adult/pharma/
// gambling keywords, which Google can penalize the *entire shared domain*
// for — every store sits on one platform-wide SEO surface (see
// AI_INSTRUCTIONS.md → North star), so one seller's keyword stuffing is
// everyone's problem. Runs automatically at write time (no manual review
// queue) to match the platform's zero-touch self-service rule — the owner
// never has to look at this.
//
// Deliberately a plain blocklist, not a smart/ML classifier — a classifier
// can be gamed and needs upkeep; a blocklist is transparent, instant, and
// covers the actual observed pattern (obvious spam vocabulary stuffed into
// otherwise-legitimate listings), not every conceivable spam technique. See
// CURRENT_TASK.md → סשן ב׳ for what this deliberately does NOT cover
// (thin/duplicate content, unmoderated reviews, mass-signup abuse, etc.) —
// those are platform-level judgment calls, not a keyword filter's job.
const SPAM_KEYWORDS: string[] = [
  // Hebrew — gambling / adult / pharma / scam vocabulary that shows up in
  // negative-SEO keyword stuffing on Israeli sites.
  'קזינו', 'קזינו אונליין', 'הימורים', 'פוקר אונליין', 'רולטה',
  'ויאגרה', 'וויאגרה', 'סיאליס', 'פורנו', 'סקס חינם',
  'הלוואות בלי ריבית', 'הלוואה מיידית', 'זכית בפרס', 'הרוויחו כסף מהיר',
  'ביטקוין בחינם', 'השקעה מובטחת',
  // English — same categories, common in cross-language stuffing.
  // Deliberately no bare "xxx" — it collides with ordinary marketplace text
  // (clothing sizes like "XXX-Large", model numbers, placeholder text) and
  // adult content is already covered by "porn"/"porno"/"free sex" (found in
  // review, 2026-07-14).
  'casino', 'online casino', 'gambling', 'poker online', 'roulette',
  'viagra', 'cialis', 'porn', 'porno', 'free sex',
  'payday loan', 'no credit check loan', 'you won a prize', 'work from home millionaire',
  'crypto giveaway', 'guaranteed profit', 'weight loss miracle',
  'buy followers', 'buy backlinks', 'seo backlinks',
];

// "Word" characters for boundary purposes — Latin letters/digits plus the
// Hebrew alphabet block. JS regex's built-in `\b` is defined off `\w`
// (`[A-Za-z0-9_]` only), which doesn't include Hebrew at all — every Hebrew
// letter reads as a non-word char to `\b`, so it can't bound a Hebrew
// keyword correctly. This class stands in for `\w` across both alphabets.
const WORD_CHAR = 'A-Za-z0-9\\u0590-\\u05FF';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Real word-boundary matching, not a plain substring test — a substring
// check flagged "porn" only coincidentally never collided with a real word,
// but the same approach on "xxx" (before it was dropped above) matched
// inside "XXX-Large", a completely ordinary clothing size. Lookaround
// assertions (not `\b`) so this works for the Hebrew keywords too.
function keywordRegex(keyword: string): RegExp {
  return new RegExp(`(?<![${WORD_CHAR}])${escapeRegex(keyword)}(?![${WORD_CHAR}])`, 'iu');
}

// Cheap normalize — collapse whitespace only. Case is handled by the regex's
// own `i` flag; Hebrew has no case to fold. Not a full transliteration pass
// (final-letter forms, diacritics) since the blocklist is already written in
// plain form and product text is free-typed, not adversarially obfuscated in
// the cases this is meant to catch.
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Returns the first matched spam keyword found across all given text fields, or null if clean. */
export function findSpamKeyword(...texts: (string | undefined | null)[]): string | null {
  const combined = normalize(texts.filter(Boolean).join(' '));
  if (!combined) return null;
  for (const keyword of SPAM_KEYWORDS) {
    if (keywordRegex(keyword).test(combined)) return keyword;
  }
  return null;
}

/** Hebrew, user-facing rejection message naming the offending term — shown inline on the dashboard form. */
export function spamRejectionMessage(keyword: string): string {
  return `הטקסט מכיל מונח החשוד כספאם ("${keyword}"). הסר אותו כדי להמשיך — מדובר בהגנה על דירוג הפלטפורמה בגוגל.`;
}

// ── Keyword stuffing ─────────────────────────────────────────────────────
// Distinct from the blocklist above: a *legitimate* word repeated far beyond
// natural writing ("משלוח" 8x across a tag list, "cheap cheap cheap...") is
// its own well-known Google manipulative-content penalty trigger, separate
// from profanity/spam-vocabulary — flagged directly by the owner as part of
// what they meant by "spam" (see CURRENT_TASK.md → סשן ב׳). Same automatic,
// reject-at-submission shape as findSpamKeyword — no manual review queue.

// Common function words excluded from the frequency count on each side —
// without this, a word like "the"/"עם" would dominate almost any English/
// Hebrew text's word-frequency purely from normal grammar, not stuffing.
// Not exhaustive; just enough to keep ordinary sentences from tripping the
// density check.
const STOPWORDS = new Set([
  // English
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'our', 'you',
  'are', 'was', 'were', 'will', 'can', 'has', 'have', 'had', 'not', 'but',
  'all', 'new', 'get', 'buy', 'shop', 'free', 'best', 'more', 'most', 'than',
  'then', 'into', 'out', 'over', 'under', 'only', 'just', 'also', 'very',
  'its', 'of', 'to', 'in', 'on', 'at', 'as', 'is', 'a', 'an', 'be', 'or', 'by',
  // Hebrew
  'את', 'של', 'עם', 'על', 'גם', 'זה', 'זו', 'זהו', 'אני', 'הוא', 'היא',
  'הם', 'הן', 'אבל', 'או', 'כי', 'לא', 'יש', 'אין', 'כל', 'כמו', 'אחד',
  'אחת', 'הכי', 'מאוד', 'ליד', 'בין', 'אצל', 'כדי', 'כך', 'אלא', 'רק',
  'עוד', 'כבר', 'אז', 'שלנו', 'שלכם', 'שלך', 'שלו', 'שלה', 'אנחנו',
  'אתם', 'אתן', 'זאת', 'היה', 'היתה', 'יהיה', 'תהיה', 'הזה', 'הזאת',
  'אלה', 'אלו',
]);

/** Words shorter than this never enter the density count — mostly stray punctuation-adjacent noise once tokenized, not a real content word either language. */
const MIN_WORD_LENGTH = 2;
/** A word must repeat at least this many raw times before it's even considered — protects
 *  short, ordinary titles ("Red Red Wine Set") where a low repeat count would otherwise
 *  read as high density purely because the whole text is short. */
const STUFFING_MIN_COUNT = 8;
/** ...and, on top of the raw-count floor, make up at least this share of all significant
 *  words — protects a long, legitimately repetitive description (a real word mentioned
 *  8 times across 200 words) or a brand name repeated a handful of times across
 *  title+description+tags (a store's own name, explicitly called out as a case to not
 *  false-positive on) from tripping this on raw count alone. Both conditions must hold. */
const STUFFING_DENSITY_THRESHOLD = 0.3;

function tokenize(text: string): string[] {
  // Unicode-aware "word" runs — same alphabet class as keywordRegex above,
  // so anything that isn't a Latin/Hebrew letter or digit is a separator.
  const matches = text.toLowerCase().match(new RegExp(`[${WORD_CHAR}]+`, 'gu')) ?? [];
  return matches.filter((w) => w.length >= MIN_WORD_LENGTH && !STOPWORDS.has(w));
}

export interface StuffingResult {
  word: string;
  count: number;
}

/** Detects a single significant word repeated far beyond natural writing across the combined
 *  text — keyword stuffing, not profanity (see findSpamKeyword for that). Returns the worst
 *  offending word + its raw count, or null if nothing crosses both the count and density bar. */
export function findKeywordStuffing(...texts: (string | undefined | null)[]): StuffingResult | null {
  const words = tokenize(texts.filter(Boolean).join(' '));
  if (words.length === 0) return null;

  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);

  let worst: StuffingResult | null = null;
  for (const [word, count] of counts) {
    if (count < STUFFING_MIN_COUNT) continue;
    if (count / words.length < STUFFING_DENSITY_THRESHOLD) continue;
    if (!worst || count > worst.count) worst = { word, count };
  }
  return worst;
}

/** Hebrew, user-facing rejection message naming the repeated word — shown inline on the dashboard form. */
export function stuffingRejectionMessage(result: StuffingResult): string {
  return `המילה "${result.word}" חוזרת ${result.count} פעמים בטקסט — זה נראה כמו "הצפת מילות מפתח" (keyword stuffing), דפוס שגוגל קונס עליו אתרים. נסחו מחדש עם פחות חזרות כדי להמשיך.`;
}
