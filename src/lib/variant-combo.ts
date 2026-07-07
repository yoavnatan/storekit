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

export type VariantSelection = Record<string, string>;

export function comboKey(selection: VariantSelection): string {
  return Object.keys(selection)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${selection[k]}`)
    .join(',');
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
