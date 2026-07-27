import { comboKey, type VariantSelection } from './variant-combo.js';
import type { BulkRowResult } from './csv-bulk.js';
import type { ProductVariant } from './store-products.js';

// The bulk CSV expresses a variant product the way Shopify/Matrixify do: several rows sharing one
// `group` value, each row = one purchasable combo (blue-L, blue-S, orange-L) with its own SKU +
// stock. Each combo's dimensions come from up to three generic option name/value column pairs
// (option1Name="צבע", option1Value="כחול"), so ANY dimension works — color, size, material, volume —
// not a fixed color/size. The seller's own dimension name is stored verbatim on the product, so the
// export→import round-trip is faithful; comboKey (variant-combo.ts) sorts the names, so column order
// never affects which combo a row maps to.

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
  /** Server-side flag on an update row whose values are identical to the existing product — a no-op.
   *  The preview hides these (a re-uploaded catalog / stock feed is mostly unchanged rows, and listing
   *  hundreds of them to "confirm" is unusable) and commit skips them entirely (nothing written). */
  unchanged?: boolean;
  /** For a variant product: each combo's source CSV line and a readable label (its option values),
   *  keyed by comboKey — lets the preview point at the exact row(s) a variant update actually changes
   *  instead of the whole product's line span. */
  comboLineByKey?: Record<string, number>;
  comboLabelByKey?: Record<string, string>;
  /** Filled server-side on a variant update: only the combos whose stock/sku differ from the stored
   *  product — so "edited one variant" shows that one row, not all N. Empty when only a shared field
   *  (name/price/…) changed. */
  changedCombos?: Array<{ line: number; label: string }>;
}

function passthrough(r: BulkRowResult): MergedRowResult {
  return { lines: [r.line], action: r.action, id: r.id, input: r.input, errors: r.errors };
}

/** Collapses per-row validation results into one result per product: rows sharing a non-empty
 *  `group` value — OR the same existing product `id` when they omit the group column — merge into a
 *  single variant product; every other row passes through unchanged. Grouping by a REPEATED id is
 *  what stops a variant product's N combo rows (a seller who filled in id + per-combo stock but not
 *  the group column) from showing up as N duplicate "updates" to the same product and, on commit,
 *  overwriting its whole matrix N times. A row with a unique id stays a plain single-product update
 *  (its variants left untouched). Output order follows each group's first appearance, so preview/
 *  commit stay aligned. */
export function mergeVariantGroups(results: BulkRowResult[]): MergedRowResult[] {
  const idCounts = new Map<string, number>();
  for (const r of results) if (r.id) idCounts.set(r.id, (idCounts.get(r.id) ?? 0) + 1);
  // Explicit group wins; otherwise a shared id that appears on more than one row is an implicit group.
  const groupKeyOf = (r: BulkRowResult): string | undefined => {
    const g = r.group?.trim();
    if (g) return `g:${g}`;
    if (r.id && (idCounts.get(r.id) ?? 0) > 1) return `id:${r.id}`;
    return undefined;
  };

  const output: MergedRowResult[] = [];
  const bucketPos = new Map<string, number>(); // group key → its slot index in `output`
  const buckets = new Map<string, BulkRowResult[]>();

  for (const r of results) {
    const key = groupKeyOf(r);
    if (!key) { output.push(passthrough(r)); continue; }
    if (!buckets.has(key)) {
      buckets.set(key, []);
      bucketPos.set(key, output.length);
      output.push({ lines: [], action: 'error', errors: [] }); // placeholder, replaced below
    }
    buckets.get(key)!.push(r);
  }

  for (const [key, rows] of buckets) output[bucketPos.get(key)!] = finalizeGroup(rows);
  return output;
}

function finalizeGroup(rows: BulkRowResult[]): MergedRowResult {
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

  // The dimensions (names, in slot order) are taken from the first row; every other row must declare
  // the SAME set of dimension names (order-independent), each with a non-empty value.
  const dimNames = (first.variantOptions ?? []).filter((o) => o.name && o.value).map((o) => o.name);
  if (!dimNames.length) push('variant-missing-option');
  const dimSet = [...dimNames].sort().join('|');

  const options: Record<string, string[]> = Object.fromEntries(dimNames.map((n) => [n, [] as string[]]));
  const variantStock: Record<string, number> = {};
  const variantSku: Record<string, string> = {};
  const comboLineByKey: Record<string, number> = {};
  const comboLabelByKey: Record<string, string> = {};
  const seen = new Set<string>();
  for (const r of rows) {
    const inp = r.input!;
    const opts = inp.variantOptions ?? [];
    // A slot with a name but a blank value (or vice versa) is a half-filled dimension for this combo.
    if (opts.some((o) => !o.name || !o.value)) { push('variant-missing-option'); continue; }
    if ([...opts.map((o) => o.name)].sort().join('|') !== dimSet) { push('variant-inconsistent-dimensions'); continue; }
    const selection: VariantSelection = {};
    for (const o of opts) {
      selection[o.name] = o.value;
      if (!options[o.name]!.includes(o.value)) options[o.name]!.push(o.value);
    }
    const key = comboKey(selection);
    if (seen.has(key)) push('variant-duplicate-combo');
    seen.add(key);
    variantStock[key] = inp.stock ?? 0;
    if (inp.sku) variantSku[key] = inp.sku;
    comboLineByKey[key] = r.line;
    comboLabelByKey[key] = opts.map((o) => o.value).join(' / ');
  }

  if (errors.length) return { lines, action: 'error', errors };

  // Dimensions keep the first row's slot order; each keeps its first-seen option order.
  const variants: ProductVariant[] = dimNames.map((name) => ({ name, options: options[name]! }));

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
  return { lines, action: ids[0] ? 'update' : 'create', id: ids[0], input, variantCount: rows.length, comboLineByKey, comboLabelByKey, errors: [] };
}
