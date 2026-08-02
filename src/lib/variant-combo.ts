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
