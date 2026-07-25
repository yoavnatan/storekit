import { comboKey, type VariantSelection } from './variant-combo.js';
import type { BulkRowResult } from './csv-bulk.js';
import type { ProductVariant } from './store-products.js';

// The bulk CSV expresses a variant product the way Google Merchant / Shopify do: several rows
// sharing one `group` value, each row = one purchasable combo (blue-L, blue-S, orange-L) with
// its own SKU + stock. Only two variant columns exist — color and size — because they cover the
// vast majority of retail variants and map 1:1 onto the two synonym groups variant-combo.ts
// already knows (color / מידה). A product needing an exotic dimension (material, etc.) is still
// built in the single-product editor; the CSV round-trip leaves such a product as one flat row.

/** The dimension name stored on the product, per UI language — kept canonical so isColorVariant()
 *  / canonicalDimName() classify it and the feed's color/size attributes resolve. */
const COLOR_DIM = { he: 'צבע', en: 'Color' } as const;
const SIZE_DIM  = { he: 'מידה', en: 'Size' } as const;

/** A merged product ready for bulkUpsertProducts — a superset of a single row's BulkProductInput
 *  that also carries the assembled variant matrix. `sku` is intentionally absent: a variant
 *  product's identity codes live per-combo in `variantSku`, not at product level. */
export interface MergedProductInput {
  name: string;
  price: number;
  stock?: number;
  categoryPath?: string[];
  tags?: string[];
  description?: string;
  variants?: ProductVariant[];
  variantStock?: Record<string, number>;
  variantSku?: Record<string, string>;
}

/** One product's outcome after grouping — `lines` is every source CSV line that fed it (one for a
 *  standalone product, several for a variant group), so the preview can still point at real rows. */
export interface MergedRowResult {
  lines: number[];
  action: 'create' | 'update' | 'error';
  id?: string;
  input?: MergedProductInput;
  /** Combos built for a variant product (absent for a plain single-row product). */
  variantCount?: number;
  errors: string[];
  /** Filled server-side for update rows so the seller can confirm the id resolved to the right product. */
  currentName?: string;
}

function passthrough(r: BulkRowResult): MergedRowResult {
  return { lines: [r.line], action: r.action, id: r.id, input: r.input, errors: r.errors };
}

/** Collapses per-row validation results into one result per product: rows sharing a non-empty
 *  `group` value merge into a single variant product; every other row passes through unchanged.
 *  Output order follows each group's first appearance, so preview/commit stay aligned. */
export function mergeVariantGroups(results: BulkRowResult[], lang: 'he' | 'en'): MergedRowResult[] {
  const output: MergedRowResult[] = [];
  const bucketPos = new Map<string, number>(); // group value → its slot index in `output`
  const buckets = new Map<string, BulkRowResult[]>();

  for (const r of results) {
    const group = r.group?.trim();
    if (!group) { output.push(passthrough(r)); continue; }
    if (!buckets.has(group)) {
      buckets.set(group, []);
      bucketPos.set(group, output.length);
      output.push({ lines: [], action: 'error', errors: [] }); // placeholder, replaced below
    }
    buckets.get(group)!.push(r);
  }

  for (const [group, rows] of buckets) output[bucketPos.get(group)!] = finalizeGroup(rows, lang);
  return output;
}

function finalizeGroup(rows: BulkRowResult[], lang: 'he' | 'en'): MergedRowResult {
  const lines = rows.map((r) => r.line).sort((a, b) => a - b);

  // A group is all-or-nothing: one bad row means we can't safely assemble the variant matrix.
  if (rows.some((r) => r.action === 'error')) {
    return { lines, action: 'error', errors: [...new Set(rows.flatMap((r) => r.errors))] };
  }

  const inputs = rows.map((r) => r.input!); // no error rows past the guard above → input always present
  const first = inputs[0]!;
  const errors: string[] = [];
  const push = (e: string) => { if (!errors.includes(e)) errors.push(e); };

  const ids = [...new Set(rows.map((r) => r.id).filter((v): v is string => !!v))];
  if (ids.length > 1) push('variant-group-mixed-id');

  const colorName = COLOR_DIM[lang];
  const sizeName = SIZE_DIM[lang];
  const anyColor = inputs.some((i) => !!i.variantColor);
  const anySize = inputs.some((i) => !!i.variantSize);
  // A dimension present on some rows but blank on others has no consistent option set.
  if (anyColor && !inputs.every((i) => !!i.variantColor)) push('variant-inconsistent-dimensions');
  if (anySize && !inputs.every((i) => !!i.variantSize)) push('variant-inconsistent-dimensions');
  if (!anyColor && !anySize) push('variant-missing-option');

  const colorOptions: string[] = [];
  const sizeOptions: string[] = [];
  const variantStock: Record<string, number> = {};
  const variantSku: Record<string, string> = {};
  const seen = new Set<string>();
  for (const inp of inputs) {
    const selection: VariantSelection = {};
    if (anyColor && inp.variantColor) {
      const c = inp.variantColor.trim();
      selection[colorName] = c;
      if (!colorOptions.includes(c)) colorOptions.push(c);
    }
    if (anySize && inp.variantSize) {
      const s = inp.variantSize.trim();
      selection[sizeName] = s;
      if (!sizeOptions.includes(s)) sizeOptions.push(s);
    }
    const key = comboKey(selection);
    if (seen.has(key)) push('variant-duplicate-combo');
    seen.add(key);
    variantStock[key] = inp.stock ?? 0;
    if (inp.sku) variantSku[key] = inp.sku;
  }

  if (errors.length) return { lines, action: 'error', errors };

  const variants: ProductVariant[] = [];
  if (anyColor) variants.push({ name: colorName, options: colorOptions });
  if (anySize) variants.push({ name: sizeName, options: sizeOptions });

  // Shared product fields come from the group's first row; per-combo stock is authoritative, so
  // the product-level `stock` is just the total (keeps grids/isProductInStock sane as a fallback).
  const input: MergedProductInput = {
    name: first.name,
    price: first.price,
    stock: Object.values(variantStock).reduce((a, b) => a + b, 0),
    categoryPath: first.categoryPath,
    tags: first.tags,
    description: first.description,
    variants,
    variantStock,
    variantSku: Object.keys(variantSku).length ? variantSku : undefined,
  };
  return { lines, action: ids[0] ? 'update' : 'create', id: ids[0], input, variantCount: rows.length, errors: [] };
}
