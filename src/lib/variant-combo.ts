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

/** Splits `total` units across `count` combos as evenly as possible, handing the remainder to the first rows — the default per-combo stock shown when a variant product has no explicit `variantStock` map yet (shared pool). */
export function evenSplit(count: number, total: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** The complete per-combo stock map a variant product effectively has, matching exactly what the dashboard's stock breakdown shows: an explicit `variantStock` entry when present, else 0 once any override exists, else the even split of the shared `stock` pool. Used to persist a full map the moment a single combo is edited inline, so the shared-pool → per-combo conversion is consistent with the displayed numbers. */
export function resolveVariantStockMap(variants: VariantDimension[], variantStock: Record<string, number> | undefined, totalStock: number): Record<string, number> {
  const existing = variantStock ?? {};
  const hasAnyStock = Object.keys(existing).length > 0;
  const combos = generateCombos(variants);
  const splitDefaults = hasAnyStock ? [] : evenSplit(combos.length, totalStock);
  const out: Record<string, number> = {};
  combos.forEach((combo, i) => {
    const key = comboKey(combo);
    out[key] = key in existing ? existing[key] : (hasAnyStock ? 0 : (splitDefaults[i] ?? 0));
  });
  return out;
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
