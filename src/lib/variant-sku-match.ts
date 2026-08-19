import { OPTION_SLOTS, type RawImportRow } from './csv-bulk.js';
import { comboKey, generateCombos, realDimensions, type VariantSelection } from './variant-combo.js';
import type { StoreProduct } from './store-products.js';

/**
 * Resolve import rows keyed by a PER-COMBO sku — the shape every external inventory system emits.
 *
 * **What was broken (found 2026-08-19, external-sync audit).** `csv-bulk.ts#resolveSkuMatches`
 * matches a row's sku against product-level skus only. A variant product has none: its identity
 * codes live per combo in `variantSku` (blue-L is the thing a POS counts, not "the sweatshirt").
 * So a feed whose rows are `SW-BL-L,7` — the minimal, and by far the commonest, external stock
 * export — resolved to nothing, and the row fell through as a CREATE. Two ways that ended, both
 * measured before this file existed:
 *
 *   • bare `sku,qty` rows → `name-required`, `price-invalid`, `sku-duplicate` — every row, every run;
 *   • Shopify-style rows (group + option columns + combo skus) → `sku-duplicate` on the whole group,
 *     because the codes are already live on the product they describe.
 *
 * Either way a seller's variant stock could never sync at all, on a timer or by hand, and nothing
 * said so beyond a preview nobody reads on a scheduled run.
 *
 * **The sku is the identity — the row's own labels are not.** A resolved row gets the STORED
 * combo's option cells written into it, overwriting whatever the feed said, because the vendor's
 * spelling of "Blue" is their business and ours is what our catalogue, storefront and orders are
 * keyed by. That also makes the match rename-proof in the one direction that matters: relabelling
 * a dimension here moves the codes with it (`variant-combo.ts#remapComboKeys`), so the vendor's
 * file keeps matching without anyone re-exporting anything.
 *
 * What this deliberately does NOT do is let a feed restructure a product. It resolves rows to
 * combos that already exist; combos it never mentions are left alone by the partial-merge flag the
 * importer sets (`store-products-bulk.ts`). An inventory feed moves quantities. Adding, removing or
 * renaming a combo is the seller's edit, in the form or in a full CSV upload.
 */
export interface ComboSkuTarget {
  productId: string;
  /** The stored combo this sku names. */
  key: string;
  selection: VariantSelection;
  /** Dimension names in the product's own slot order — what the option columns get written as. */
  dimNames: string[];
  name: string;
  price: number;
  /** false when the product has more dimensions than the CSV's three option slots can express. */
  expressible: boolean;
}

/** sku → the combo it names, over a whole store's catalogue. First claim wins, so a duplicated code
 *  (which the import's own sku-uniqueness check rejects on the way in) can never silently move a
 *  row onto the later product. */
export function buildComboSkuIndex(products: StoreProduct[]): Map<string, ComboSkuTarget> {
  const index = new Map<string, ComboSkuTarget>();
  for (const product of products) {
    const codes = product.variantSku;
    if (!codes || !Object.keys(codes).length) continue;
    const dims = realDimensions(product.variants);
    if (!dims.length) continue;
    const dimNames = dims.map((d) => d.name);
    const expressible = dims.length <= OPTION_SLOTS.length;
    for (const selection of generateCombos(dims)) {
      const key = comboKey(selection);
      const sku = codes[key];
      if (!sku || index.has(sku)) continue;
      index.set(sku, { productId: product.id, key, selection, dimNames, name: product.name, price: product.price, expressible });
    }
  }
  return index;
}

/**
 * Rewrite every id-less row whose sku names an existing combo into an ordinary id-matched variant
 * row — the same shape a seller's own export produces — and report which lines those were.
 *
 * Runs AFTER `resolveSkuMatches`, so a product-level sku always wins: a plain product and a combo
 * cannot share a code (the importer validates uniqueness across both), and an explicit id column
 * still beats everything.
 *
 * The `group` cell is set (when the feed left it blank) so a single row still merges as a variant
 * group of one instead of arriving as a flat stock update, which the importer rightly refuses on a
 * per-combo product. Rows of different products get different group values, so nothing merges that
 * should not.
 */
export function resolveComboSkuRows(rows: RawImportRow[], index: Map<string, ComboSkuTarget>): Set<number> {
  const resolved = new Set<number>();
  if (!index.size) return resolved;

  for (const row of rows) {
    if (row.cells.id?.trim()) continue;
    const sku = row.cells.sku?.trim();
    if (!sku) continue;
    const target = index.get(sku);
    if (!target) continue;

    row.cells.id = target.productId;
    if (!row.cells.name?.trim()) row.cells.name = target.name;
    if (!row.cells.price?.trim()) row.cells.price = String(target.price);

    // Four or more dimensions: the file physically cannot spell the combo out, so the row is left
    // flat on purpose. It now resolves to the right product, which is what turns the outcome from
    // "sku-duplicate" into the importer's own `variant-stock-dashboard-only` — the message that
    // names the only place such a product's stock can be edited.
    if (!target.expressible) continue;

    if (!row.cells.group?.trim()) row.cells.group = `sku:${target.productId}`;
    OPTION_SLOTS.forEach((slot, i) => {
      const dim = target.dimNames[i];
      row.cells[slot.name] = dim ?? '';
      row.cells[slot.value] = dim ? (target.selection[dim] ?? '') : '';
    });
    resolved.add(row.line);
  }
  return resolved;
}
