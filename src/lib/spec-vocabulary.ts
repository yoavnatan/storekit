/**
 * What a seller is OFFERED when filling the product form's "מפרט" rows — the write side of
 * `product-facets.ts`.
 *
 * **The problem it exists for.** Filtering reads the attributes a seller already types, which makes
 * the feature free of new fields and new forms. The price of that is drift: `3-5` on one product,
 * `גילאי 3-5` on the next and `3 עד 5` on the third are one attribute to a shopper and three chips
 * in the panel. `facetKey` folds the differences that carry no meaning (case, spacing, five dash
 * characters); it deliberately will not guess that `3 עד 5` is the same range, because a filter that
 * merges attributes on a hunch merges the wrong two eventually.
 *
 * So convergence happens here instead, at the moment of typing, and by **suggestion only**. The
 * seller sees what their own store already used and clicks it, or ignores it and types anything
 * they like. Nothing is required, nothing is rejected, no row is pre-filled and no rubric is put in
 * front of anyone — a form that asks a seller to answer a scheme they did not choose is a barrier
 * at exactly the moment we need them to keep uploading (memory `feedback_seller_form_burden`).
 *
 * **Two sources, in this order.**
 *   1. The store's own history — every label and value already on its products. Always wins, because
 *      it is the vocabulary that store has actually settled on, and because matching it is what
 *      makes the panel work for that store.
 *   2. A small starter set per platform category (owner's call, 2026-08-20: "נקודת פתיחה לפי תחום"),
 *      for the case history cannot cover — the first product in a new store, where there is nothing
 *      to learn from. A toy shop is offered גיל / מגדר / סוג משחק; it is free to use none of them.
 *
 * **Why the starter set is per platform category and not per store category.** `Store.categories`
 * comes from a curated vocabulary of 24 (`store-taxonomy.ts`), so this table can be complete and
 * stay complete. A store's own tree is unbounded free text, and keying off it would be a table that
 * is permanently missing the next shop — the same split, and the same reason, as
 * `category-icons.ts` (memory `project_category_icons_scope`): a curated map for the curated
 * vocabulary, nothing for the free-text one.
 *
 * Pure/isomorphic — no `node:fs`, no queries. It runs in the dashboard's browser bundle as the
 * seller types, and SSR could call it too. Same class as `tag-suggest.ts`, which suggests the OTHER
 * free-text field on the same form.
 */
import { facetKey, MAX_FACET_TEXT_LENGTH } from './product-facets.js';

/** Attribute names offered at once. More than this is a scheme rather than a hint. */
export const MAX_SUGGESTED_LABELS = 8;
/** Values offered for one attribute. Enough to recognise the house spelling, not a catalogue. */
export const MAX_SUGGESTED_VALUES = 10;

/**
 * The starter attribute names, per platform store category.
 *
 * Chosen against one test: would a shopper in this kind of shop want to narrow by it, in a way the
 * shop's own shelves cannot already express? So `חומר` is here and `שם המוצר` is not, and neither
 * is `צבע` — a colour is normally a purchasable variant, which is a different field with its own
 * picker, and suggesting it as a spec would send sellers to write it twice.
 *
 * Deliberately short. Three or four names read as a hint; ten read as a form to fill in.
 * `כלבו` is intentionally absent: a general store has no attribute in common by definition.
 */
export const STARTER_SPEC_LABELS: Readonly<Record<string, readonly string[]>> = {
  'אופנה':      ['חומר', 'סגנון', 'עונה', 'גזרה'],
  'בגדים':      ['חומר', 'סגנון', 'עונה', 'גזרה'],
  'הנעלה':      ['חומר', 'סגנון', 'עונה'],
  'תיקים':      ['חומר', 'סגנון', 'נפח'],
  'תכשיטים':    ['חומר', 'אבן', 'אורך'],
  'טיפוח':      ['סוג עור', 'נפח', 'ריח'],
  'אלקטרוניקה': ['חיבור', 'מקור חשמל', 'אחריות'],
  'מחשבים':     ['חיבור', 'נפח אחסון', 'אחריות'],
  'סלולר':      ['תאימות', 'חיבור', 'חומר'],
  'אביזרים':    ['חומר', 'תאימות', 'סגנון'],
  'לבית':       ['חומר', 'חדר', 'סגנון'],
  'מטבח':       ['חומר', 'נפח', 'מדיח כלים'],
  'ריהוט':      ['חומר', 'מידות', 'סגנון'],
  'ספורט':      ['ענף', 'רמה', 'חומר'],
  'מזון':       ['כשרות', 'אלרגנים', 'משקל'],
  'פרחים':      ['אירוע', 'גודל', 'עונה'],
  'צמחים':      ['אור', 'רמת טיפוח', 'גודל עציץ'],
  'צעצועים':    ['גיל', 'מגדר', 'סוג משחק'],
  'לתינוק':     ['גיל', 'מגדר', 'חומר'],
  'חיות מחמד':  ['סוג חיה', 'גודל', 'גיל'],
  'ספרים':      ['ז׳אנר', 'שפה', 'כריכה'],
  'כלי עבודה':  ['מקור חשמל', 'שימוש', 'אחריות'],
  'רכב':        ['התאמה לדגם', 'שנתון'],
  'מתנות':      ['אירוע', 'קהל יעד'],
};

/**
 * Starter VALUES that mean the same thing in every shop, keyed by the attribute's `facetKey`.
 *
 * An age band is an age band whether it is on a toy or a book, so these need no vertical. The ones
 * that DO depend on the shop live in `STARTER_CATEGORY_VALUES` below — and that split is the whole
 * design here, because "חומר" is the same word and a completely different list in a clothes shop
 * and a furniture shop. One global list for it would offer oak to someone selling shirts.
 */
export const STARTER_SPEC_VALUES: Readonly<Record<string, readonly string[]>> = {
  'גיל':        ['0-2', '3-5', '6-8', '9-12', '12+'],
  'מגדר':       ['בנים', 'בנות', 'יוניסקס'],
  'עונה':       ['קיץ', 'חורף', 'מעבר', 'כל השנה'],
  'רמה':        ['מתחילים', 'מתקדמים', 'מקצועי'],
  'אור':        ['שמש מלאה', 'אור עקיף בהיר', 'סובל צל'],
  'רמת טיפוח':  ['קלה', 'בינונית', 'תובענית'],
  'כשרות':      ['פרווה', 'חלבי', 'בשרי'],
  'קהל יעד':    ['לילדים', 'לנשים', 'לגברים', 'לכל המשפחה'],
  'אחריות':     ['שנה', 'שנתיים', 'שלוש שנים'],
  'גודל':       ['קטן', 'בינוני', 'גדול'],
  'סגנון':      ['יומיומי', 'קלאסי', 'מודרני'],
};

/**
 * Starter values **per vertical** — the same attribute name, the list that shop actually uses.
 *
 * Added 2026-08-20 at the owner's request, after seeing the strip work on one store: "תעשה לי עוד
 * סוגים של חנויות נפוצות שמקבלות הצעות". The attribute NAMES already covered 23 of the 24 platform
 * categories; what was thin was the values, and values are the half that matters — a seller spells
 * "חומר" the same way every time without help and spells "עץ מלא" three ways by the third product.
 *
 * **This reverses a position stated in the first draft of this file**, which said an attribute
 * whose values are open (`חומר`, `סגנון`) gets none, "because a list that cannot be complete reads
 * as a restriction". The premise was wrong about what the seller sees: this is a strip of dashed
 * chips beside a text box that accepts anything, filtered live by what they type — the same shape
 * as the tag suggestions on the same form — not a dropdown that has to enumerate the world. A short
 * partial list is a hint; only a control that REFUSES the unlisted value would be a restriction,
 * and nothing here refuses anything.
 *
 * Each list stays at four to six. Past that it stops being an example and starts being a form.
 */
export const STARTER_CATEGORY_VALUES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'בגדים':      { 'חומר': ['כותנה', 'פשתן', 'צמר', 'ויסקוזה', 'דנים', 'עור'],
                  'סגנון': ['יומיומי', 'ערב', 'ספורטיבי', 'קלאסי'],
                  'גזרה': ['צמודה', 'רגילה', 'אוברסייז'] },
  'הנעלה':      { 'חומר': ['עור', 'זמש', 'בד', 'סינתטי'],
                  'סגנון': ['יומיומי', 'ספורטיבי', 'אלגנטי'] },
  'תיקים':      { 'חומר': ['עור', 'בד', 'ניילון', 'זמש'],
                  'סגנון': ['יומיומי', 'ערב', 'עבודה'],
                  'נפח': ['קטן', 'בינוני', 'גדול'] },
  'תכשיטים':    { 'חומר': ['כסף', 'זהב', 'גולדפילד', 'פלדת אל־חלד'],
                  'אבן': ['יהלום', 'זירקון', 'אבן חן', 'פנינה'] },
  'טיפוח':      { 'סוג עור': ['יבש', 'שמן', 'מעורב', 'רגיש'],
                  'ריח': ['ללא בישום', 'פרחוני', 'הדרים', 'וניל'] },
  'אלקטרוניקה': { 'חיבור': ['אלחוטי', 'USB-C', 'HDMI', 'כבל'],
                  'מקור חשמל': ['סוללה נטענת', 'סוללות', 'חיבור לחשמל'] },
  'מחשבים':     { 'חיבור': ['USB-C', 'USB-A', 'HDMI', 'אלחוטי'],
                  'נפח אחסון': ['256GB', '512GB', '1TB', '2TB'] },
  'סלולר':      { 'תאימות': ['אייפון', 'אנדרואיד', 'אוניברסלי'],
                  'חיבור': ['USB-C', 'Lightning', 'אלחוטי'],
                  'חומר': ['סיליקון', 'פלסטיק קשיח', 'עור'] },
  'אביזרים':    { 'חומר': ['מתכת', 'בד', 'עור', 'פלסטיק'],
                  'תאימות': ['אוניברסלי'] },
  'לבית':       { 'חומר': ['עץ', 'קרמיקה', 'זכוכית', 'מתכת', 'בד'],
                  'חדר': ['סלון', 'מטבח', 'חדר שינה', 'אמבטיה', 'חדר ילדים'],
                  'סגנון': ['מודרני', 'כפרי', 'סקנדינבי', 'תעשייתי'] },
  'מטבח':       { 'חומר': ['נירוסטה', 'קרמיקה', 'זכוכית', 'עץ', 'סיליקון'],
                  'מדיח כלים': ['מתאים', 'לא מתאים'] },
  'ריהוט':      { 'חומר': ['עץ מלא', 'סנדוויץ׳', 'מתכת', 'בד', 'ראטן'],
                  'סגנון': ['מודרני', 'כפרי', 'סקנדינבי', 'תעשייתי'] },
  'ספורט':      { 'ענף': ['ריצה', 'כושר', 'יוגה', 'אופניים', 'שחייה'],
                  'חומר': ['נושם', 'עמיד למים', 'כותנה'] },
  'מזון':       { 'אלרגנים': ['גלוטן', 'אגוזים', 'חלב', 'סויה', 'ללא'] },
  'פרחים':      { 'אירוע': ['יום הולדת', 'אהבה', 'ניחומים', 'תודה', 'חג'] },
  'צמחים':      { 'גודל עציץ': ['8 ס״מ', '12 ס״מ', '17 ס״מ', '21 ס״מ'] },
  'צעצועים':    { 'סוג משחק': ['הרכבה', 'חשיבה', 'יצירה', 'כלי רכב', 'בובות', 'משחקי קופסה'] },
  'לתינוק':     { 'חומר': ['כותנה', 'במבוק', 'סיליקון', 'עץ'] },
  'חיות מחמד':  { 'סוג חיה': ['כלב', 'חתול', 'מכרסם', 'ציפור', 'דגים'] },
  'ספרים':      { 'ז׳אנר': ['מתח', 'רומן', 'עיון', 'ילדים', 'פנטזיה', 'ביוגרפיה'],
                  'שפה': ['עברית', 'אנגלית', 'דו־לשוני'],
                  'כריכה': ['רכה', 'קשה'] },
  'כלי עבודה':  { 'מקור חשמל': ['חשמלי', 'נטען', 'ידני', 'פנאומטי'],
                  'שימוש': ['ביתי', 'מקצועי'] },
  'רכב':        { 'התאמה לדגם': ['אוניברסלי'] },
  'מתנות':      { 'אירוע': ['יום הולדת', 'חתונה', 'לידה', 'חג', 'תודה'] },
};

/** One attribute and the values seen under it, most-used first. */
export interface SpecVocabularyEntry {
  label: string;
  values: string[];
}

/** Everything the seller may be offered on this store's product form. */
export interface SpecVocabulary {
  entries: SpecVocabularyEntry[];
}

interface Tally {
  spellings: Map<string, number>;
  values: Map<string, Map<string, number>>;
  count: number;
}

function bump(counts: Map<string, number>, text: string): void {
  counts.set(text, (counts.get(text) ?? 0) + 1);
}

/** Most-used spelling wins; ties by name so the offer is stable between two renders. */
function topSpelling(counts: Map<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [text, count] of counts) {
    if (count > bestCount || (count === bestCount && text.localeCompare(best, 'he') < 0)) {
      best = text;
      bestCount = count;
    }
  }
  return best;
}

/** Ranked by use, then alphabetically — the same total order the facet panel uses. */
function rankByUse(counts: Map<string, Map<string, number>>, limit: number): string[] {
  const ranked = [...counts.entries()]
    .map(([, spellings]) => ({
      text: topSpelling(spellings),
      total: [...spellings.values()].reduce((sum, n) => sum + n, 0),
    }))
    .sort((a, b) => b.total - a.total || a.text.localeCompare(b.text, 'he'));
  return ranked.slice(0, limit).map((r) => r.text);
}

/**
 * The vocabulary a store has actually used, read off its own products.
 *
 * Grouped by `facetKey`, so two spellings of one attribute are one entry offering the spelling that
 * store uses most — which is precisely the nudge that makes the third product match the first two
 * instead of inventing a third spelling.
 *
 * `storeCategories` are the store's PLATFORM categories (`Store.categories`); their starter names
 * are appended after everything the store already uses, and never displace it.
 */
export function buildSpecVocabulary(
  products: readonly { specs?: Array<{ label: string; value: string }> | null }[],
  storeCategories: readonly string[] = [],
): SpecVocabulary {
  const labels = new Map<string, Tally>();

  for (const product of products) {
    for (const spec of product.specs ?? []) {
      const label = (spec?.label ?? '').trim();
      const value = (spec?.value ?? '').trim();
      if (!label || label.length > MAX_FACET_TEXT_LENGTH) continue;
      const labelKey = facetKey(label);
      if (!labelKey) continue;
      let tally = labels.get(labelKey);
      if (!tally) {
        tally = { spellings: new Map(), values: new Map(), count: 0 };
        labels.set(labelKey, tally);
      }
      bump(tally.spellings, label);
      tally.count++;
      // An empty value is a half-filled row, not an attribute value — the label still counts,
      // because the seller clearly intends to use it.
      if (!value || value.length > MAX_FACET_TEXT_LENGTH) continue;
      const valueKey = facetKey(value);
      if (!valueKey) continue;
      let spellings = tally.values.get(valueKey);
      if (!spellings) {
        spellings = new Map();
        tally.values.set(valueKey, spellings);
      }
      bump(spellings, value);
    }
  }

  const entries: SpecVocabularyEntry[] = [];
  const taken = new Set<string>();
  const ordered = [...labels.entries()]
    .sort((a, b) => b[1].count - a[1].count
      || topSpelling(a[1].spellings).localeCompare(topSpelling(b[1].spellings), 'he'));

  for (const [labelKey, tally] of ordered) {
    if (entries.length >= MAX_SUGGESTED_LABELS) break;
    const label = topSpelling(tally.spellings);
    taken.add(labelKey);
    entries.push({
      label,
      values: mergeValues(rankByUse(tally.values, MAX_SUGGESTED_VALUES), labelKey, storeCategories),
    });
  }

  // The starter set fills what history could not. Appended, never inserted — a store that has
  // settled on its own three attributes should not be shown ours above them.
  for (const label of starterLabelsFor(storeCategories)) {
    if (entries.length >= MAX_SUGGESTED_LABELS) break;
    const labelKey = facetKey(label);
    if (!labelKey || taken.has(labelKey)) continue;
    taken.add(labelKey);
    entries.push({ label, values: mergeValues([], labelKey, storeCategories) });
  }

  return { entries };
}

/**
 * The starter names for a store's platform categories, de-duplicated and in the order the seller
 * chose their categories — a store tagged אופנה + הנעלה is offered אופנה's names first.
 */
export function starterLabelsFor(storeCategories: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const category of storeCategories) {
    for (const label of STARTER_SPEC_LABELS[category] ?? []) {
      const key = facetKey(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(label);
    }
  }
  return out;
}

/**
 * Store history first, then the starter values it has not already covered.
 *
 * **Order among the starters is vertical-first.** A store tagged ריהוט that has written nothing yet
 * should be offered עץ מלא before it is offered anything generic, because that is the list its own
 * catalogue will end up using; a universal value only fills what is left. A store carrying two
 * categories gets both lists, in the order it chose them, which is the same rule `starterLabelsFor`
 * follows one level up.
 */
function mergeValues(own: string[], labelKey: string, storeCategories: readonly string[]): string[] {
  const out = [...own];
  const seen = new Set(own.map((v) => facetKey(v)));
  const add = (value: string): void => {
    if (out.length >= MAX_SUGGESTED_VALUES) return;
    const key = facetKey(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };
  for (const category of storeCategories) {
    for (const value of STARTER_CATEGORY_VALUES[category]?.[labelKey] ?? []) add(value);
  }
  for (const value of STARTER_SPEC_VALUES[labelKey] ?? []) add(value);
  return out;
}

/**
 * The subset of a vocabulary worth showing for what the seller has typed so far.
 *
 * Prefix-and-substring, case-folded through `facetKey`, and it hides an exact match: once the field
 * already says exactly what a suggestion would say, the suggestion is a button that does nothing
 * (memory `feedback_noop_interactions_invisible`).
 */
export function matchSuggestions(options: readonly string[], typed: string, limit: number): string[] {
  const needle = facetKey(typed);
  const matches: string[] = [];
  for (const option of options) {
    const key = facetKey(option);
    if (!key || key === needle) continue;
    if (needle && !key.includes(needle)) continue;
    matches.push(option);
    if (matches.length >= limit) break;
  }
  return matches;
}
