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
 * Starter VALUES, keyed by the attribute's `facetKey`.
 *
 * A much shorter list than the labels above, and that asymmetry is the point: a seller spells
 * `גיל` the same way every time without help, and spells the range differently every time. These
 * are only the attributes whose values are a small closed set that everyone writes differently —
 * ranges, scales and seasons. An attribute whose values are genuinely open (`חומר`, `סגנון`) gets
 * no starter values at all, because a list that cannot be complete reads as a restriction.
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
      values: mergeValues(rankByUse(tally.values, MAX_SUGGESTED_VALUES), labelKey),
    });
  }

  // The starter set fills what history could not. Appended, never inserted — a store that has
  // settled on its own three attributes should not be shown ours above them.
  for (const label of starterLabelsFor(storeCategories)) {
    if (entries.length >= MAX_SUGGESTED_LABELS) break;
    const labelKey = facetKey(label);
    if (!labelKey || taken.has(labelKey)) continue;
    taken.add(labelKey);
    entries.push({ label, values: mergeValues([], labelKey) });
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

/** Store history first, then any starter value it has not already covered. */
function mergeValues(own: string[], labelKey: string): string[] {
  const out = [...own];
  const seen = new Set(own.map((v) => facetKey(v)));
  for (const value of STARTER_SPEC_VALUES[labelKey] ?? []) {
    if (out.length >= MAX_SUGGESTED_VALUES) break;
    const key = facetKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
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
