import { COLOR_VARIANT_NAME_GROUP } from './color-variants.js';

export interface VariantDimension {
  name: string;
  options: string[];
}

// Synonym groups (singular/plural, Hebrew/English) that count as the same
// dimension for duplicate-title detection — a seller typing "מידות" when
// "מידה" already exists shouldn't be allowed to create a second rubric for
// the same thing. Unrecognized names just compare by trimmed lowercase.
const DIM_NAME_SYNONYM_GROUPS: string[][] = [
  COLOR_VARIANT_NAME_GROUP,
  ['מידה', 'מידות', 'size', 'sizes'],
];

const DIM_NAME_CANONICAL_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const group of DIM_NAME_SYNONYM_GROUPS) for (const name of group) map[name] = group[0];
  return map;
})();

export function canonicalDimName(name: string): string {
  const key = name.trim().toLowerCase();
  return DIM_NAME_CANONICAL_MAP[key] ?? key;
}

/** Fixed low-stock threshold (units), shared by the checkout notification trigger and the dashboard's red-number stock display — lives in this pure/isomorphic file (no `node:fs`) so browser-bundled dashboard scripts can import it too, unlike `store-products.ts`. A per-store/per-product override can replace this later without changing call sites. */
export const LOW_STOCK_THRESHOLD = 3;

export type VariantSelection = Record<string, string>;

export function comboKey(selection: VariantSelection): string {
  return Object.keys(selection)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${selection[k]}`)
    .join(',');
}

/** True if at least one purchasable combo has stock — the shared `stock` pool for a combo with no `variantStock` override, that combo's own entry otherwise. Plain `stock > 0` alone is wrong for a variant product: the shared pool can read 0 while an overridden combo still has stock (or vice versa). */
export function isProductInStock(stock: number, variants: VariantDimension[] | undefined, variantStock: Record<string, number> | undefined): boolean {
  if (!variants?.length) return stock > 0;
  return generateCombos(variants).some((combo) => (variantStock?.[comboKey(combo)] ?? stock) > 0);
}

/**
 * One combo's stock situation — the shape every surface that shows or edits per-combo stock reads.
 *
 * **`variantStock` is PARTIAL, and that is a fact about the product, not a gap to fill in.** A
 * combo with no entry sells from the shared `stock` pool (store-products.ts#resolveStockField),
 * and migration 0003 made the column nullable so the database can say the same thing. The
 * dashboard used to hide that: adding a colour dimension to a product with 10 units immediately
 * wrote `{red: 5, blue: 5}` — an even split of a number the seller never broke down. A seller
 * holding 8 red and 2 blue then refused the 6th red sale on stock that existed, and oversold three
 * blue that did not. The split is gone; a combo the seller has not counted stays on the pool, and
 * `shared` is how a caller tells the two apart instead of guessing from a number.
 */
export interface ComboStock {
  key: string;
  selection: VariantSelection;
  /** This combo's own bucket, or undefined when it has none and sells from the shared pool. */
  override?: number;
  /** What this combo can actually sell right now — its override, else the shared pool. */
  effective: number;
  /** true = no bucket of its own; `effective` is the shared pool, which its siblings also draw on. */
  shared: boolean;
}

/** Every combo of `variants`, each resolved against the partial `variantStock` map and the shared pool. */
export function comboStockRows(
  variants: VariantDimension[],
  variantStock: Record<string, number> | undefined,
  sharedStock: number,
): ComboStock[] {
  const existing = variantStock ?? {};
  return generateCombos(variants).map((selection) => {
    const key = comboKey(selection);
    const has = key in existing;
    const override = has ? existing[key] : undefined;
    return { key, selection, override, effective: has ? override! : sharedStock, shared: !has };
  });
}

/** True once every combo carries its own bucket — the point at which the shared pool no longer
 *  sells anything, so the product's overall `stock` is exactly the sum of the buckets. */
export function isFullyPerCombo(variants: VariantDimension[], variantStock: Record<string, number> | undefined): boolean {
  const rows = comboStockRows(variants, variantStock, 0);
  return rows.length > 0 && rows.every((r) => !r.shared);
}

/** Sum of the explicit buckets only — the shared pool is deliberately not added in, because it is
 *  one pool shared by every combo that has no bucket, not a per-combo quantity to total up. */
export function sumComboOverrides(variantStock: Record<string, number> | undefined): number {
  return Object.values(variantStock ?? {}).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0);
}

/**
 * How many combos `dimensions` describes — WITHOUT building them.
 *
 * The whole point is that it is a multiplication rather than an expansion, because every caller
 * that needs this number is deciding whether expanding is safe (see MAX_VARIANT_COMBOS). Uses the
 * same "a dimension with no name or no options is not a dimension" rule as `generateCombos`, so the
 * count is the length that call would return and not an estimate of it.
 */
export function comboCount(dimensions: VariantDimension[]): number {
  let n = 1;
  for (const dim of dimensions) {
    if (!dim.name || !dim.options.length) continue;
    n *= dim.options.length;
    // A seller cannot type enough options to overflow a float, but a hand-posted payload can, and
    // `Infinity > MAX` is the answer this exists to give — bail rather than keep multiplying.
    if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) return Infinity;
  }
  return n;
}

/**
 * The most combos one product may define — the bound on every expansion in this file.
 *
 * **This is a size limit that behaves like a security one (found 2026-08-06).** The cartesian
 * product is exponential in the number of dimensions while the payload that describes it is
 * linear: three dimensions of fifty options is a few kilobytes of JSON and 125,000 combos, and
 * `parseVariantsPayload` used to expand exactly that on the request thread — allocating an object
 * AND a sorted `comboKey` string per combo — before any validation had a chance to reject it. A
 * product form is authenticated, so this is not an anonymous DoS, but one seller (or one stolen
 * session) could stall SSR for everybody, and the same shape reaches the CSV importer, where a few
 * dozen rows can imply tens of thousands of combos.
 *
 * 200 because it is far above any real catalogue (5 colours × 8 sizes × 4 materials = 160, and the
 * dashboard renders a stock input per combo, which is already unusable long before this) and far
 * below the point where expanding one costs anything. Enforced at the INPUT gates — the product
 * form and the CSV importer — so stored data is bounded by construction and every reader
 * downstream (storefront, feed, dashboard) can expand without checking. `tests/variant-combo-limit.test.ts`
 * pins that both gates check it.
 */
export const MAX_VARIANT_COMBOS = 200;

/** True when this dimension set is over the limit — the question an input gate asks BEFORE expanding. */
export function exceedsComboLimit(dimensions: VariantDimension[]): boolean {
  return comboCount(dimensions) > MAX_VARIANT_COMBOS;
}

export function generateCombos(dimensions: VariantDimension[]): VariantSelection[] {
  return dimensions.reduce<VariantSelection[]>(
    (combos, dim) => {
      if (!dim.name || !dim.options.length) return combos;
      const next: VariantSelection[] = [];
      for (const combo of combos) {
        for (const opt of dim.options) next.push({ ...combo, [dim.name]: opt });
      }
      return next;
    },
    [{}]
  );
}
