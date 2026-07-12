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
