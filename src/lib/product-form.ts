import type { ProductVariant } from './store-products.js';
import { comboKey, generateCombos } from './variant-combo.js';

export function parseImages(form: FormData): string[] {
  return form.getAll('images').map(v => String(v).trim()).filter(Boolean);
}

export function parseCategory(form: FormData): string {
  return String(form.get('category') ?? '').trim();
}

export function parseSku(form: FormData): string {
  return String(form.get('sku') ?? '').trim();
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
      const url = String(val ?? '').trim();
      if (!validOptionValues.has(key) || !url || !submittedImages.has(url)) continue;
      variantImages[key] = url;
    }
  }

  return { variants, variantStock, variantImages };
}
