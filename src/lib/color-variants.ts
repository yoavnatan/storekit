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
  // Warm/neutral retail names. Added 2026-08-12 with the showcase catalogs, but
  // they are not showcase vocabulary — these are the words an Israeli clothing or
  // homeware shop actually writes on a product, and without them the storefront
  // renders a text chip where a swatch belongs (resolveVariantColor returns null).
  'טרקוטה': '#c4622d',
  'חמרה': '#a8552f',
  'קוניאק': '#9a5b33',
  'חול': '#e0d3bf',
  'שמנת': '#f2ebdd',
  'קרם': '#f2ebdd',
  'אבן': '#cfc7ba',
  'טאופ': '#b0a49a',
  'זית': '#6f8f5f',
  'מרווה': '#9caf88',
  'חאקי': '#8f8460',
  'בורדו': '#7b1f2b',
  'גרפיט': '#3a3f47',
  'אוף וייט': '#f5f2ec',
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

/**
 * The words that mean "more than one colour", and therefore cannot have a hex.
 *
 * Every other value in this file resolves to a single swatch. "צבעוני" resolved to nothing at all,
 * so a seller who typed it got the fallback colour PICKER and had to invent a hex for a product
 * that is deliberately not one colour — and whatever they picked then lied about it on the
 * storefront (owner, 2026-08-28: *"אין לי שם כזה קשת או משהו מיוחד, לצבע מיוחד"*).
 *
 * Kept apart from `COLOR_MAP` rather than mapped to some representative hex, because the answer is
 * not a colour: it is "draw the rainbow". A hex here would have every caller painting one arbitrary
 * shade and no caller able to tell that it was arbitrary.
 */
const MULTICOLOR_NAMES = new Set([
  'צבעוני', 'רב צבעוני', 'רב-צבעוני', 'מגוון', 'קשת', 'ססגוני',
  'multicolor', 'multicolour', 'multi-color', 'multi-colour', 'multi', 'rainbow', 'assorted',
]);

export interface ResolvedColor {
  display: string;
  /** A single colour, or null when there is none to show — including a multicolour value. */
  hex: string | null;
  /** "Many colours" — paint `variantSwatchBackground()`'s rainbow rather than a swatch. */
  multi: boolean;
}

export function resolveVariantColor(option: string): ResolvedColor {
  const hexMatch = option.match(/#([0-9a-fA-F]{3,6})\b/);
  if (hexMatch) {
    const display = option.replace(/#([0-9a-fA-F]{3,6})\b/, '').trim();
    return { display: display || option, hex: '#' + hexMatch[1], multi: false };
  }
  const key = option.trim().toLowerCase();
  // A hex the seller typed WINS over the word, above — "צבעוני #ffffff" is somebody who wanted a
  // specific shade and said so, and this branch must not overrule them.
  if (MULTICOLOR_NAMES.has(key)) return { display: option, hex: null, multi: true };
  return { display: option, hex: COLOR_MAP[key] ?? null, multi: false };
}

/**
 * What to paint in a swatch — the ONE definition, so five renderers cannot disagree.
 *
 * `null` means "there is nothing to draw": the dashboard answers that with its colour picker, the
 * storefront with a plain text chip. Both of those already existed; what did not was a value that
 * has a swatch and no hex, which is why this returns a CSS background rather than a colour.
 *
 * The rainbow is a conic gradient, not a linear one: on a 14px circle a linear sweep reads as two
 * colours with a smear between them, while a conic one reads as a colour wheel at any size — and
 * these swatches are drawn at 14px in the dashboard and 24px on the storefront from the same call.
 */
export function variantSwatchBackground(color: ResolvedColor): string | null {
  if (color.hex) return color.hex;
  if (!color.multi) return null;
  return 'conic-gradient(#e53e3e, #f97316, #eab308, #22c55e, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #e53e3e)';
}

// Exported (not just a local Set) so other variant-name logic — e.g. dashboard
// duplicate-title detection in variant-combo.ts — can treat these as one name
// too, instead of re-declaring the same Hebrew/English synonym list.
export const COLOR_VARIANT_NAME_GROUP = ['צבע', 'צבעים', 'color', 'colors', 'colour', 'colours'];
const COLOR_VARIANT_NAMES = new Set(COLOR_VARIANT_NAME_GROUP);

export function isColorVariant(variantName: string): boolean {
  return COLOR_VARIANT_NAMES.has(variantName.trim().toLowerCase());
}
