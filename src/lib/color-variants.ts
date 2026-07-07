const COLOR_MAP: Record<string, string> = {
  // Hebrew
  'אדום': '#e53e3e',
  'כחול': '#3b82f6',
  'ירוק': '#22c55e',
  'שחור': '#1f2937',
  'לבן': '#f1f5f9',
  'צהוב': '#eab308',
  'כתום': '#f97316',
  'סגול': '#8b5cf6',
  'ורוד': '#ec4899',
  'חום': '#92400e',
  'אפור': '#6b7280',
  "בז'": '#d4b89a',
  'בז': '#d4b89a',
  'זהב': '#d4a017',
  'כסף': '#9ca3af',
  'טורקיז': '#06b6d4',
  'נייבי': '#1e40af',
  'מנטה': '#6ee7b7',
  'לבנדר': '#c4b5fd',
  'קורל': '#fb7185',
  'חרדל': '#ca8a04',
  'כחול כהה': '#1e40af',
  'כחול בהיר': '#bfdbfe',
  'ירוק כהה': '#166534',
  'ירוק בהיר': '#bbf7d0',
  'אדום כהה': '#991b1b',
  'ורוד בהיר': '#fce7f3',
  // English
  'red': '#e53e3e',
  'blue': '#3b82f6',
  'green': '#22c55e',
  'black': '#1f2937',
  'white': '#f1f5f9',
  'yellow': '#eab308',
  'orange': '#f97316',
  'purple': '#8b5cf6',
  'pink': '#ec4899',
  'brown': '#92400e',
  'gray': '#6b7280',
  'grey': '#6b7280',
  'beige': '#d4b89a',
  'gold': '#d4a017',
  'silver': '#9ca3af',
  'turquoise': '#06b6d4',
  'teal': '#0d9488',
  'navy': '#1e40af',
  'mint': '#6ee7b7',
  'lavender': '#c4b5fd',
  'coral': '#fb7185',
  'mustard': '#ca8a04',
  'cream': '#fef9c3',
  'ivory': '#fffff0',
  'olive': '#65a30d',
  'maroon': '#9f1239',
  'indigo': '#4f46e5',
  'cyan': '#06b6d4',
  'magenta': '#d946ef',
};

export interface ResolvedColor {
  display: string;
  hex: string | null;
}

export function resolveVariantColor(option: string): ResolvedColor {
  const hexMatch = option.match(/#([0-9a-fA-F]{3,6})\b/);
  if (hexMatch) {
    const display = option.replace(/#([0-9a-fA-F]{3,6})\b/, '').trim();
    return { display: display || option, hex: '#' + hexMatch[1] };
  }
  const key = option.trim().toLowerCase();
  return { display: option, hex: COLOR_MAP[key] ?? null };
}

// Exported (not just a local Set) so other variant-name logic — e.g. dashboard
// duplicate-title detection in variant-combo.ts — can treat these as one name
// too, instead of re-declaring the same Hebrew/English synonym list.
export const COLOR_VARIANT_NAME_GROUP = ['צבע', 'צבעים', 'color', 'colors', 'colour', 'colours'];
const COLOR_VARIANT_NAMES = new Set(COLOR_VARIANT_NAME_GROUP);

export function isColorVariant(variantName: string): boolean {
  return COLOR_VARIANT_NAMES.has(variantName.trim().toLowerCase());
}
