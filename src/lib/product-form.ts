import type { ProductVariant } from './store-products.js';
import { comboKey, generateCombos, exceedsComboLimit, MAX_VARIANT_COMBOS } from './variant-combo.js';
import { sanitizeImageUrl, sanitizeImageUrls } from './image-url.js';
import { normalizeProductDiscount } from './discount-input.js';
import type { ProductDiscount } from './discounts.js';
import { parseWeightGrams } from './product-weight.js';

/** Every image URL a seller submits, validated + normalized (image-url.ts).
 *  Anything that isn't an https:// or site-relative URL is dropped here rather
 *  than stored — until 2026-07-29 this took the raw string, so a hand-crafted
 *  POST could park arbitrary markup in `images[]` and reach the render layer. */
export function parseImages(form: FormData): string[] {
  return sanitizeImageUrls(form.getAll('images'));
}

export function parseCategoryId(form: FormData): string {
  return String(form.get('categoryId') ?? '').trim();
}

export function parseSku(form: FormData): string {
  return String(form.get('sku') ?? '').trim();
}

/** The manufacturer's brand, for a reseller. Capped because it is a name, not a description —
 *  and it lands in the ad feed and the Product JSON-LD, where a pasted paragraph is a rejected
 *  item rather than a long one. Blank is the normal answer: it keeps the store-name fallback. */
export function parseBrand(form: FormData): string {
  return String(form.get('brand') ?? '').trim().slice(0, 70);
}

/** Shipping weight in grams. The rules — including why an unusable value becomes "not stated"
 *  rather than 0 — belong to lib/product-weight.ts, so the form path has no second opinion. */
export function parseWeight(form: FormData): number | undefined {
  return parseWeightGrams(form.get('weightGrams'));
}

/** Private seller-only note. Capped to keep a runaway paste out of the JSON store. */
export function parseSellerNote(form: FormData): string {
  return String(form.get('sellerNote') ?? '').trim().slice(0, 2000);
}

/** The product edit/add form's discount block → a normalized `ProductDiscount` (or `undefined`,
 *  which REMOVES an existing discount). `price` bounds a ₪-off so it can't zero the product out.
 *  `showBadge` is read as a checkbox: absent from the payload means the seller unticked it, so it
 *  is passed explicitly rather than left to the default-true normalizer. */
export function parseProductDiscount(form: FormData, price: number): ProductDiscount | undefined {
  // "no discount" picked in the select — an explicit removal, whatever stale value the amount
  // input may still be carrying.
  if (!String(form.get('discount_type') ?? '').trim()) return undefined;
  return normalizeProductDiscount({
    type: form.get('discount_type'),
    value: form.get('discount_value'),
    showBadge: form.get('discount_badge') === null ? '0' : '1',
    startsAt: form.get('discount_starts'),
    endsAt: form.get('discount_ends'),
  }, price);
}

export function parseTags(form: FormData): string[] {
  return String(form.get('tags') ?? '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}

export function parseSpecs(form: FormData): Array<{ label: string; value: string }> {
  const labels = form.getAll('specs_label').map(v => String(v).trim());
  const values = form.getAll('specs_value').map(v => String(v).trim());
  return labels.map((label, i) => ({ label, value: values[i] ?? '' })).filter(s => s.label);
}

export interface VariantsPayload {
  variants: ProductVariant[];
  variantStock: Record<string, number>;
  variantImages: Record<string, string>;
  /** Set when the submission must be REJECTED rather than stored — today only the combo limit.
   *  A caller that ignores it stores a bounded-but-different variant set, which is why
   *  `tests/variant-combo-limit.test.ts` checks the API route reads it. */
  error?: string;
}

/** Parses the single `variants_json` field the dashboard serializes before submit — replaces
 *  the old parallel `variant_name`/`variant_options` array zipping, which silently misaligned
 *  if a block was ever added/removed out of order. */
export function parseVariantsPayload(form: FormData): VariantsPayload {
  const empty: VariantsPayload = { variants: [], variantStock: {}, variantImages: {} };
  const raw = String(form.get('variants_json') || '');
  if (!raw) return empty;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return empty; }
  if (!parsed || typeof parsed !== 'object') return empty;
  const obj = parsed as { variants?: unknown; variantStock?: unknown; variantImages?: unknown };

  const variants: ProductVariant[] = Array.isArray(obj.variants)
    ? obj.variants
        .map((v): ProductVariant | null => {
          if (!v || typeof v !== 'object') return null;
          const name = String((v as { name?: unknown }).name ?? '').trim();
          const rawOptions = (v as { options?: unknown }).options;
          const options = Array.isArray(rawOptions)
            ? rawOptions.map((o) => String(o).trim()).filter(Boolean)
            : [];
          return name && options.length ? { name, options } : null;
        })
        .filter((v): v is ProductVariant => v !== null)
    : [];

  // BEFORE the first expansion, not after: `generateCombos` below is exponential in the number of
  // dimensions while this payload is linear in it, so the check has to happen while the cartesian
  // product is still a multiplication (variant-combo.ts#MAX_VARIANT_COMBOS).
  if (exceedsComboLimit(variants)) {
    return { ...empty, error: `יותר מדי צירופי וריאציות (מקסימום ${MAX_VARIANT_COMBOS}). צמצמו מספר אפשרויות או מימדים.` };
  }

  // Only keep stock entries for combos that actually exist for the final variant set —
  // guards against stale/tampered keys once options are renamed or removed client-side.
  const validKeys = new Set(generateCombos(variants).map(comboKey));
  const variantStock: Record<string, number> = {};
  if (obj.variantStock && typeof obj.variantStock === 'object') {
    for (const [key, val] of Object.entries(obj.variantStock as Record<string, unknown>)) {
      if (!validKeys.has(key)) continue;
      const n = Math.floor(Number(val));
      if (Number.isFinite(n) && n >= 0) variantStock[key] = n;
    }
  }

  // Keys must be a real option value on the final variant set (guards against a
  // stale entry after an option was renamed/removed); values must be one of this
  // submission's own images — never trust an arbitrary client-supplied URL.
  const validOptionValues = new Set(variants.flatMap((v) => v.options));
  const submittedImages = new Set(parseImages(form));
  const variantImages: Record<string, string> = {};
  if (obj.variantImages && typeof obj.variantImages === 'object') {
    for (const [key, val] of Object.entries(obj.variantImages as Record<string, unknown>)) {
      // Sanitized before the membership check, not after: `submittedImages` holds
      // NORMALIZED urls (parseImages), so comparing a raw string against it could
      // miss a match that is really the same image.
      const url = sanitizeImageUrl(val);
      if (!validOptionValues.has(key) || !url || !submittedImages.has(url)) continue;
      variantImages[key] = url;
    }
  }

  return { variants, variantStock, variantImages };
}
