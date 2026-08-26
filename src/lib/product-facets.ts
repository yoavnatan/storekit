/**
 * Filtering a catalog by the ATTRIBUTES a product has, as opposed to the one shelf it sits on.
 *
 * **The question this answers** (owner, CURRENT_TASK סשן ד׳, standing in a toy shop): a shopper
 * there asks three things at once — for what age, what kind of play, and for whom. The category
 * tree can answer exactly one of them, because a tree says where a product *lives* and a product
 * lives in one place. Pushing the other two into the tree multiplies it: five ages × three genders
 * × six play types is ninety folders for a sixty-product store, most of them empty, and the seller
 * still has to file each product into exactly one.
 *
 * The standard answer, and it did not change in 2026: **one taxonomy, orthogonal attributes beside
 * it.** Google Merchant is built this way (`product_type` is the tree; `age_group`, `gender`,
 * `color`, `size` are separate fields), Shopify likewise. Nothing here touches the category tree.
 *
 * **Where the attributes come from — `specs`, and nothing new.** A seller already fills a
 * label/value list in the product form ("מפרט"), it already renders on the product page, and it is
 * already emitted as `additionalProperty` in the Product JSON-LD. It simply never filtered
 * anything. So this feature is a reader: no schema change, no migration, no new field, and no
 * seller who has to be taught something. What a seller DOES get is
 * `spec-vocabulary.ts` — suggestions that make two products spell the same attribute the same way,
 * which is the one thing free text cannot do by itself.
 *
 * **Variants are deliberately NOT a source here.** Colour/size facets were designed and deferred on
 * 2026-08-14 (memory `project_variant_values_searchable`) because their numeric bounds would be
 * calibrated against an invented catalogue; that trigger — a real store with a deep category — has
 * not fired, and building this for `specs` does not fire it either. `productFacetPairs` below is
 * the single extraction point, so adding `variants` as a second source later is a change to one
 * function and nothing else. Do not add it before the trigger.
 *
 * **Why every bound below is a number and not a judgement.** The whole risk the owner named is
 * "סיבוך יתר" — a panel that appears when it helps nobody, or shows forty chips. Each threshold is
 * exported and tested, and the facets are computed from the products **currently in view**, never
 * from the whole store: that is what keeps a drill-down narrowing rather than compounding.
 */
import type { StoreProduct } from './store-products.js';

// ── Bounds ──────────────────────────────────────────────────────────────────

/** A label carried by one product filters nothing — picking its value hides every other product. */
export const MIN_PRODUCTS_PER_FACET = 2;
/** One distinct value is not a choice: every product in view already has it. */
export const MIN_VALUES_PER_FACET = 2;
/**
 * Past this many distinct values the label is free prose, not an attribute — "הערה" or a
 * per-product measurement. Dropped entirely rather than truncated: showing 8 of 60 arbitrary values
 * presents a filter that cannot find most of the catalogue.
 */
export const MAX_VALUES_PER_FACET = 20;
/** Chips rendered before "עוד" — the rest stay one click away rather than filling the panel. */
export const FACET_VALUES_SHOWN = 8;
/** At most three dimensions, the ones covering the most products. */
export const MAX_FACETS = 3;
/**
 * Longest label/value that can be an attribute. A spec value is "3-5" or "עץ", never a sentence,
 * and this is the cheap guard that keeps a seller's paragraph-in-a-spec-row out of the chip row.
 * Applied to the RAW text before normalising, so a long value cannot slip through by collapsing.
 */
export const MAX_FACET_TEXT_LENGTH = 32;

/**
 * A single-facet view joins the sitemap's crawlable surface only once it holds a real collection.
 * Below this it is a thin page, and a thin page is a cost to the whole domain rather than to itself
 * (the same call `store-readiness.ts` makes one level up for a whole store).
 */
export const FACET_INDEX_MIN_PRODUCTS = 8;

/** Longest `?f=` value that will be looked at — far above any real selection (3 × 8 short keys). */
const MAX_PARAM_LENGTH = 300;

// ── Normalising ─────────────────────────────────────────────────────────────

/**
 * The grouping key for a label or a value.
 *
 * Free text drifts, and the drift is the whole reason a naive version of this feature produces a
 * broken-looking panel: `3-5`, `3–5` (en dash) and `3 - 5` are one attribute to a person and three
 * filters to a computer. This collapses exactly the differences that carry no meaning — case,
 * whitespace, the five dash characters a Hebrew keyboard and an Israeli spreadsheet can each
 * produce, and the punctuation that ends up on the edges of a pasted cell.
 *
 * What it deliberately does NOT do is understand words: `3 עד 5` stays distinct from `3-5`, because
 * guessing that they mean the same thing is how a filter starts merging attributes that differ.
 * That gap is closed on the WRITE side instead, by suggesting what the store already used
 * (`spec-vocabulary.ts`) — a seller who clicks a suggestion converges; a rule that rewrites their
 * text does not have their consent and will one day be wrong.
 *
 * `:`, `,` and `~` are removed rather than escaped, because this key is also the URL token
 * (`FACET_PARAM`). A key that cannot contain a separator needs no escaping and therefore has no
 * round-trip to get wrong — the parser compares keys and never has to reverse one.
 *
 * Splitting only, no backtracking regex: this runs over untrusted URL text
 * (memory `project_attribute_escaping_xss`).
 */
export function facetKey(raw: string): string {
  if (!raw) return '';
  let s = raw.normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of s) {
    // Every dash-like character folds to one, so an en dash and a hyphen are the same size range.
    if (ch === '‐' || ch === '‑' || ch === '‒' || ch === '–'
      || ch === '—' || ch === '―' || ch === '־' || ch === '−') { out += '-'; continue; }
    // The URL's own separators, plus the quote forms Hebrew typing produces in two spellings each.
    if (ch === ':' || ch === ',' || ch === '~' || ch === '|') { out += ' '; continue; }
    if (ch === '׳' || ch === '’') { out += "'"; continue; }
    if (ch === '״' || ch === '“' || ch === '”') { out += '"'; continue; }
    out += ch;
  }
  // Collapse runs of whitespace without a quantified regex.
  s = out.split(/\s+/).filter(Boolean).join(' ');
  // Trim the punctuation a pasted cell carries on its edges. A leading/trailing dash is noise;
  // an inner one is a range and must survive.
  const EDGE = new Set(['-', '.', ',', ';', "'", '"', '(', ')', '[', ']', '/', '\\', '*', '#']);
  let start = 0;
  let end = s.length;
  while (start < end && EDGE.has(s[start]!)) start++;
  while (end > start && EDGE.has(s[end - 1]!)) end--;
  return s.slice(start, end);
}

/**
 * Is this label/value usable as an attribute at all?
 *
 * The length test is on the RAW text on purpose — see `MAX_FACET_TEXT_LENGTH`. The letter-or-digit
 * test drops a value that is only punctuation ("—", "?"), which is what an emptied spreadsheet cell
 * leaves behind and which would otherwise become a chip with no label.
 */
function isFacetableText(raw: string): boolean {
  if (!raw) return false;
  if (raw.length > MAX_FACET_TEXT_LENGTH) return false;
  return /[\p{L}\p{N}]/u.test(raw);
}

// ── Extraction ──────────────────────────────────────────────────────────────

export interface FacetPair {
  labelKey: string;
  label: string;
  valueKey: string;
  value: string;
}

/**
 * Every (attribute, value) a product carries — **the one place that decides what a facet is made
 * of.** Today: its `specs` rows. See the header for why `variants` is not here yet.
 *
 * A product listing the same label twice keeps both values (a seller can legitimately write
 * "מתאים ל: בנים" and "מתאים ל: בנות"), but the same label+value twice collapses to one, so a
 * duplicated row cannot count a product twice toward a threshold.
 */
export function productFacetPairs(product: Pick<StoreProduct, 'specs'>): FacetPair[] {
  const pairs: FacetPair[] = [];
  const seen = new Set<string>();
  for (const spec of product.specs ?? []) {
    const label = (spec?.label ?? '').trim();
    const value = (spec?.value ?? '').trim();
    if (!isFacetableText(label) || !isFacetableText(value)) continue;
    const labelKey = facetKey(label);
    const valueKey = facetKey(value);
    if (!labelKey || !valueKey) continue;
    const dedupe = `${labelKey} ${valueKey}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    pairs.push({ labelKey, label, valueKey, value });
  }
  return pairs;
}

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * Sizes need their own order or the panel reads as broken — `L` between `M` and `S` alphabetically
 * is the classic tell that nobody looked at the finished row.
 */
const SIZE_ORDER = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', '2xl', '3xl'];

/** The leading number of a value, so `3-5` sorts before `6-8` and `12+` after both. */
function leadingNumber(key: string): number | null {
  let digits = '';
  for (const ch of key) {
    if (ch >= '0' && ch <= '9') digits += ch;
    else break;
  }
  return digits ? Number(digits) : null;
}

/**
 * Value order inside one facet: numeric ranges first by their number, then clothing sizes by the
 * scale, then whatever is left by how much of the catalogue it covers, and finally by name so the
 * result is total. **Determinism is not cosmetic here** — the same view is rendered by the server,
 * re-rendered by the client after a filter, and declared as a canonical URL, and two orderings of
 * one view is how a canonical ends up pointing at a page nobody links to.
 */
export function compareFacetValues(a: FacetValue, b: FacetValue): number {
  const an = leadingNumber(a.key);
  const bn = leadingNumber(b.key);
  if (an !== null && bn !== null && an !== bn) return an - bn;
  if (an !== null && bn === null) return -1;
  if (an === null && bn !== null) return 1;
  const ai = SIZE_ORDER.indexOf(a.key);
  const bi = SIZE_ORDER.indexOf(b.key);
  if (ai !== -1 && bi !== -1 && ai !== bi) return ai - bi;
  if (ai !== -1 && bi === -1) return -1;
  if (ai === -1 && bi !== -1) return 1;
  if (a.count !== b.count) return b.count - a.count;
  return a.key.localeCompare(b.key, 'he');
}

// ── Computation ─────────────────────────────────────────────────────────────

export interface FacetValue {
  /** What the shopper reads — the spelling most products in view use. */
  value: string;
  /** What the URL and the matcher use (`facetKey`). */
  key: string;
  /** Products in view carrying it. */
  count: number;
}

export interface Facet {
  label: string;
  key: string;
  /** Ordered, already capped to `MAX_VALUES_PER_FACET`. */
  values: FacetValue[];
  /** Products in view carrying this label at all — what facets are ranked by. */
  productCount: number;
}

/**
 * The filter panel for one set of products.
 *
 * **Computed from the products IN VIEW, never from the whole store.** That single choice is what
 * bounds the feature: inside "צעצועי הרכבה" the ages offered are the ages that shelf actually has,
 * so drilling down narrows the panel instead of compounding it, and a store whose catalogue shares
 * no attribute gets no panel at all rather than a row of one-off chips.
 *
 * `products` must already be filtered by category and search and NOT by `selection` — the panel has
 * to keep offering the dimensions it offered a moment ago. A panel recomputed from its own output
 * empties itself as it is used: pick an age, and every other age disappears along with the material
 * row, leaving a filter that can only ever be undone.
 *
 * **The counts, though, do respect the other dimensions.** Each value is counted over the products
 * that satisfy every selection EXCEPT its own — which is what makes "3-5 (12)" beside a chosen
 * material an honest number rather than a store-wide one, and is the standard way a facet count is
 * defined. A value nothing would match is dropped unless it is currently chosen, because a chip
 * that returns an empty grid is a control that does nothing
 * (memory `feedback_noop_interactions_invisible`); a chosen one stays so it can be un-chosen.
 *
 * Pure and synchronous — the caller already holds the array (the store page loads it to count
 * categories), so this adds no query and no round trip.
 */
export function computeFacets(
  products: readonly Pick<StoreProduct, 'specs'>[],
  selection: FacetSelection = new Map(),
): Facet[] {
  // labelKey → { label spellings, valueKey → value spellings, products carrying the label }
  const labels = new Map<string, {
    labelCounts: Map<string, number>;
    values: Map<string, Map<string, number>>;
    productCount: number;
  }>();

  // Pairs are read once per product and reused by the counting pass below — `productFacetPairs`
  // walks and normalises every spec row, and doing that again per facet is the same work times three.
  const pairsByProduct: FacetPair[][] = [];

  for (const product of products) {
    const pairs = productFacetPairs(product);
    pairsByProduct.push(pairs);
    // One product counts once toward a label even when it carries that label on two rows.
    const labelsHere = new Set<string>();
    for (const pair of pairs) {
      let entry = labels.get(pair.labelKey);
      if (!entry) {
        entry = { labelCounts: new Map(), values: new Map(), productCount: 0 };
        labels.set(pair.labelKey, entry);
      }
      entry.labelCounts.set(pair.label, (entry.labelCounts.get(pair.label) ?? 0) + 1);
      if (!labelsHere.has(pair.labelKey)) {
        labelsHere.add(pair.labelKey);
        entry.productCount++;
      }
      let spellings = entry.values.get(pair.valueKey);
      if (!spellings) {
        spellings = new Map();
        entry.values.set(pair.valueKey, spellings);
      }
      spellings.set(pair.value, (spellings.get(pair.value) ?? 0) + 1);
    }
  }

  const facets: Facet[] = [];
  for (const [labelKey, entry] of labels) {
    if (entry.productCount < MIN_PRODUCTS_PER_FACET) continue;
    if (entry.values.size < MIN_VALUES_PER_FACET) continue;
    if (entry.values.size > MAX_VALUES_PER_FACET) continue;

    const chosen = selection.get(labelKey);
    const counts = countUnderOtherDimensions(pairsByProduct, selection, labelKey);
    const values: FacetValue[] = [];
    for (const [valueKey, spellings] of entry.values) {
      const count = counts.get(valueKey) ?? 0;
      if (count === 0 && !chosen?.has(valueKey)) continue;
      values.push({ key: valueKey, value: mostCommon(spellings), count });
    }
    // Both bounds are re-checked AFTER the zero-count drop: a dimension that has become a single
    // remaining option filters nothing, and showing it says a choice exists where none does.
    if (values.length < MIN_VALUES_PER_FACET) continue;
    values.sort(compareFacetValues);
    facets.push({
      key: labelKey,
      label: mostCommon(entry.labelCounts),
      values,
      productCount: entry.productCount,
    });
  }

  // Most-covering first, then the widest choice, then by name so ties are not arbitrary.
  facets.sort((a, b) =>
    b.productCount - a.productCount
    || b.values.length - a.values.length
    || a.key.localeCompare(b.key, 'he'));
  return facets.slice(0, MAX_FACETS);
}

/**
 * How many products each value of `labelKey` would leave, given every OTHER dimension's selection.
 * The dimension being counted is excluded from its own filter — that is the definition of a facet
 * count, and it is why picking a second age widens the result instead of emptying it.
 */
function countUnderOtherDimensions(
  pairsByProduct: readonly FacetPair[][],
  selection: FacetSelection,
  labelKey: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pairs of pairsByProduct) {
    let passes = true;
    for (const [otherKey, wanted] of selection) {
      if (otherKey === labelKey) continue;
      let hit = false;
      for (const pair of pairs) {
        if (pair.labelKey === otherKey && wanted.has(pair.valueKey)) { hit = true; break; }
      }
      if (!hit) { passes = false; break; }
    }
    if (!passes) continue;
    const seen = new Set<string>();
    for (const pair of pairs) {
      if (pair.labelKey !== labelKey || seen.has(pair.valueKey)) continue;
      seen.add(pair.valueKey);
      counts.set(pair.valueKey, (counts.get(pair.valueKey) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The spelling to SHOW for a key that several products spell differently. The most frequent one,
 * ties broken by name — a store where three products wrote "עץ" and one wrote "עץ" reads as the
 * catalogue mostly does, and the choice is stable across renders for the same reason the value
 * order is.
 */
function mostCommon(counts: Map<string, number>): string {
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

// ── Selection: matching, and the URL ────────────────────────────────────────

/** labelKey → the value keys chosen under it. OR within a label, AND across labels. */
export type FacetSelection = Map<string, Set<string>>;

/**
 * Does this product satisfy the selection?
 *
 * OR within a dimension and AND across dimensions, which is what every shopper already expects from
 * every shop: two ages means "either age", an age plus a material means "both".
 */
export function productMatchesFacets(
  product: Pick<StoreProduct, 'specs'>,
  selection: FacetSelection,
): boolean {
  if (selection.size === 0) return true;
  const pairs = productFacetPairs(product);
  for (const [labelKey, wanted] of selection) {
    let hit = false;
    for (const pair of pairs) {
      if (pair.labelKey === labelKey && wanted.has(pair.valueKey)) { hit = true; break; }
    }
    if (!hit) return false;
  }
  return true;
}

/** The query parameter carrying the selection. One character: it rides beside `category` and `q`. */
export const FACET_PARAM = 'f';

/**
 * Read a selection out of `?f=`.
 *
 * Everything here degrades to "no filter" rather than throwing, and every loop is bounded, because
 * this is untrusted URL text: a hand-built `?f=` is the input, not the panel that produced it. The
 * caps are the same ones the panel obeys, so a crafted URL cannot ask for more work than a real
 * click can.
 */
export function parseFacetParam(raw: string | null | undefined): FacetSelection {
  const selection: FacetSelection = new Map();
  if (!raw || raw.length > MAX_PARAM_LENGTH) return selection;
  for (const group of raw.split(',')) {
    if (selection.size >= MAX_FACETS) break;
    const at = group.indexOf(':');
    if (at <= 0) continue;
    const labelKey = facetKey(group.slice(0, at));
    if (!labelKey) continue;
    const values = new Set<string>();
    for (const rawValue of group.slice(at + 1).split('~')) {
      if (values.size >= MAX_VALUES_PER_FACET) break;
      const valueKey = facetKey(rawValue);
      if (valueKey) values.add(valueKey);
    }
    if (values.size) selection.set(labelKey, values);
  }
  return selection;
}

/**
 * Write a selection back as `?f=`.
 *
 * **Sorted, always.** One selection has exactly one spelling, so picking גיל then חומר and picking
 * חומר then גיל are the same URL — otherwise the same shelf accumulates ranking under two
 * addresses, and the canonical this page declares would depend on click order.
 */
export function buildFacetParam(selection: FacetSelection): string {
  const groups: string[] = [];
  for (const labelKey of [...selection.keys()].sort()) {
    const values = [...(selection.get(labelKey) ?? [])].sort();
    if (values.length) groups.push(`${labelKey}:${values.join('~')}`);
  }
  return groups.join(',');
}

/**
 * Is this filtered view worth putting in front of Google?
 *
 * **One dimension, one value, and a real collection behind it.** "צעצועי עץ" is a page a person
 * searches for and a page this store genuinely has; "עץ + גיל 3-5 + יוניסקס" is one of a
 * combinatorial number of views of the same products, which is the classic faceted-navigation crawl
 * trap. The count test is what makes this rule self-opening: nothing has to be revisited when a
 * catalogue deepens — a facet view crosses `FACET_INDEX_MIN_PRODUCTS` and becomes indexable on its
 * own, and falls back out if the products go.
 *
 * These views are deliberately **not enumerated in the sitemap**. They are one click from the store
 * page, which is in it, so they are discoverable; listing them would mean reading every product's
 * `specs` for every store in the sitemap job — exactly the per-product payload
 * `getVisibleProductRefsByStoreIds` was narrowed to avoid — and would push a bounded surface toward
 * the 45,000-URL shard ceiling for pages a crawler can already reach.
 */
export function isIndexableFacetView(selection: FacetSelection, matchedProducts: number): boolean {
  if (selection.size !== 1) return false;
  const [values] = [...selection.values()];
  if (!values || values.size !== 1) return false;
  return matchedProducts >= FACET_INDEX_MIN_PRODUCTS;
}

/** Toggle one value, returning a NEW selection — the panel's only mutation. */
export function toggleFacetValue(
  selection: FacetSelection,
  labelKey: string,
  valueKey: string,
): FacetSelection {
  const next: FacetSelection = new Map();
  for (const [key, values] of selection) next.set(key, new Set(values));
  const current = next.get(labelKey);
  if (current?.has(valueKey)) {
    current.delete(valueKey);
    if (current.size === 0) next.delete(labelKey);
  } else if (current) {
    if (current.size < MAX_VALUES_PER_FACET) current.add(valueKey);
  } else if (next.size < MAX_FACETS) {
    next.set(labelKey, new Set([valueKey]));
  }
  return next;
}

/** How many values are chosen in total — the number on the "סינון" button. */
export function countSelectedFacetValues(selection: FacetSelection): number {
  let total = 0;
  for (const values of selection.values()) total += values.size;
  return total;
}
