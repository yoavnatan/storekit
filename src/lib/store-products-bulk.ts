import {
  createProductIn, getProductsByStoreIdIn, updateProductIn,
  type StoreProduct, type ProductVariant,
} from './store-products.js';
import { withTransaction } from './db.js';
import { resolveOrCreateCategoryPaths, getAncestorChain, type StoreCategory } from './store-categories.js';
import { CSV_FIELDS, CSV_MAX_DIMENSIONS, BOM, sanitizeCsvCell, toCsvCell } from './csv-bulk.js';
import { roundMoney } from './money.js';
import { generateCombos, comboKey, isFullyPerCombo, sumComboOverrides } from './variant-combo.js';
import { discountedPrice } from './discounts.js';

export interface BulkUpsertInput {
  id?: string;
  name: string;
  price: number;
  /** Undefined = blank CSV cell = "leave unchanged" on update, defaults to 0 on create. */
  stock?: number;
  /** Price while the sale runs (csv-bulk.ts's `salePrice` column). Undefined = leave any existing
   *  discount alone; 0 = end the sale. Stored as a ₪-off against `price` rather than as an absolute
   *  figure so it reads the same as a discount set in the dashboard — one shape in the data. */
  salePrice?: number;
  /** Root-first segment names, e.g. ["ביגוד", "גברים"] — undefined = leave unchanged on update / no category on create. */
  categoryPath?: string[];
  tags?: string[];
  description?: string;
  sku?: string;
  /** Shipping weight in grams; undefined = blank cell = leave unchanged, same rule as every
   *  other column here. Already validated by csv-bulk.ts — an unusable value failed the row. */
  weightGrams?: number;
  /** Assembled by variant-csv.ts#mergeVariantGroups from a group of CSV rows. When present the row
   *  describes a variant product: `variants`/`variantStock`/`variantSku` replace the product's whole
   *  variant matrix and `stock` is the combo total. Absent = a plain single product (variant fields
   *  on an existing product are left untouched, matching the "blank cell = leave unchanged" rule). */
  variants?: ProductVariant[];
  variantStock?: Record<string, number>;
  variantSku?: Record<string, string>;
  /** The variant fields above describe only SOME of the product's combos — every row of the group
   *  was matched by its own per-combo sku, which is how an external inventory feed addresses a
   *  variant product (variant-sku-match.ts). Merge them into the stored matrix rather than
   *  replacing it: a feed moves quantities, it never deletes a combo it simply did not mention.
   *  Ignored on a create (there is nothing to merge into). */
  variantStockPartial?: boolean;
}

export interface BulkUpsertResult {
  id: string;
  /** 'not-found' means the row's id didn't match an existing product in this store — the caller pre-validates ids, so this should be unreachable in practice, but every input row always yields exactly one result (never silently skipped) so array-position pairing on the caller's side stays safe. */
  action: 'create' | 'update' | 'not-found';
  product?: StoreProduct;
}

/**
 * Apply a whole CSV batch to one store's catalog.
 *
 * **The batch is one transaction.** That is not a performance choice — it is what the file version
 * got for free by rewriting the file once, and what a per-row `createProduct`/`updateProduct` would
 * throw away: a thousand separate transactions mean a file that fails on row 600 leaves 599
 * products behind with nothing to identify them by, and a concurrent import interleaves with this
 * one row by row. The catalog is read INSIDE the transaction for the same reason — resolving a row
 * against one snapshot and writing over another is the lost update this module used to be one
 * `await` away from (DB_MIGRATION_PLAN.md §8, store-categories notes).
 *
 * Categories are resolved first, once for the batch (one query, not one per row): they are shared
 * structure, they commit on their own, and a row with no categoryPath (blank CSV cells) resolves
 * to null, meaning "leave unchanged". SKU uniqueness is validated by the caller (csv-bulk.ts's
 * validateRows) before rows reach here, same as name/price.
 */
export async function bulkUpsertProducts(storeId: string, rows: BulkUpsertInput[]): Promise<BulkUpsertResult[]> {
  const resolvedCategoryIds = await resolveOrCreateCategoryPaths(storeId, rows.map((r) => r.categoryPath ?? []));

  return withTransaction(async (tx) => {
    const byId = new Map((await getProductsByStoreIdIn(tx, storeId)).map((p) => [p.id, p]));
    const results: BulkUpsertResult[] = [];

    for (const [i, row] of rows.entries()) {
      const categoryId = resolvedCategoryIds[i] ?? null;
      // A variant row (assembled from a group) carries the product's whole variant matrix; only then
      // do we touch variants/variantStock/variantSku, so a plain update never clobbers them.
      const isVariant = !!row.variants?.length;
      // undefined → leave the product's discount as it is; 0 → clear it; otherwise the ₪ gap.
      const rowDiscount: StoreProduct['discount'] | undefined | null =
        row.salePrice === undefined ? undefined
          : row.salePrice <= 0 || row.salePrice >= row.price ? null
          : { type: 'amount', value: roundMoney(row.price - row.salePrice) };

      if (row.id) {
        const existing = byId.get(row.id);
        if (!existing) {
          results.push({ id: row.id, action: 'not-found' });
          continue;
        }
        // Blank CSV cell (row.field undefined) means "leave unchanged", so the key is omitted
        // entirely rather than passed as undefined — updateProduct reads `key in updates` as
        // "clear this", which is what makes an explicit blank cell removable at all.
        const updates: Parameters<typeof updateProductIn>[2] = { name: row.name, price: row.price };
        if (row.stock !== undefined) updates.stock = row.stock;
        if (categoryId) updates.categoryId = categoryId;
        if (row.tags !== undefined) updates.tags = row.tags;
        if (row.description !== undefined) updates.description = row.description;
        if (row.sku !== undefined) updates.sku = row.sku;
        if (row.weightGrams !== undefined) updates.weightGrams = row.weightGrams;
        if (rowDiscount !== undefined) updates.discount = rowDiscount ?? undefined;
        if (isVariant && row.variantStockPartial && existing.variants?.length) {
          // A per-combo-sku feed: the product's own matrix stands, and only the buckets the feed
          // named move. Merged HERE, inside the transaction, against the row read under it — the
          // importer's snapshot is minutes old on a scheduled run, and merging there would write a
          // sale that landed in between back out of existence.
          const mergedStock = { ...(existing.variantStock ?? {}), ...(row.variantStock ?? {}) };
          const mergedSku = { ...(existing.variantSku ?? {}), ...(row.variantSku ?? {}) };
          updates.variants = existing.variants;
          updates.variantStock = mergedStock;
          updates.variantSku = mergedSku;
          // The group's own `stock` is the sum of the rows it carried, which for a patch is a
          // fraction of the product — never the product's number. It is the sum of the buckets
          // exactly when every combo now has one; while any combo still sells from the shared
          // pool the file says nothing about the pool's size, so the pool is left as it is.
          if (isFullyPerCombo(existing.variants, mergedStock)) updates.stock = sumComboOverrides(mergedStock);
          else delete updates.stock;
        } else if (isVariant) {
          updates.variants = row.variants;
          updates.variantStock = row.variantStock ?? {};
          updates.variantSku = row.variantSku;
        }
        const updated = await updateProductIn(tx, row.id, updates);
        if (!updated) {
          results.push({ id: row.id, action: 'not-found' });
          continue;
        }
        results.push({ id: row.id, action: 'update', product: updated });
      } else {
        const product = await createProductIn(tx, storeId, {
          name: row.name,
          description: row.description ?? '',
          price: row.price,
          stock: row.stock ?? 0,
          ...(categoryId ? { categoryId } : {}),
          ...(row.tags?.length ? { tags: row.tags } : {}),
          ...(row.sku ? { sku: row.sku } : {}),
          ...(row.weightGrams ? { weightGrams: row.weightGrams } : {}),
          ...(rowDiscount ? { discount: rowDiscount } : {}),
          ...(isVariant ? { variants: row.variants } : {}),
          ...(isVariant && row.variantStock && Object.keys(row.variantStock).length ? { variantStock: row.variantStock } : {}),
          ...(isVariant && row.variantSku && Object.keys(row.variantSku).length ? { variantSku: row.variantSku } : {}),
        });
        results.push({ id: product.id, action: 'create', product });
      }
    }

    return results;
  });
}

const arrEq = (a: string[] = [], b: string[] = []): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
function mapEq(a: Record<string, string | number> = {}, b: Record<string, string | number> = {}): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
const variantsEq = (a: ProductVariant[] = [], b: ProductVariant[] = []): boolean =>
  a.length === b.length && a.every((v, i) => v.name === b[i]!.name && arrEq(v.options, b[i]!.options));

/** True if applying this import row to `existing` would actually change the product — mirrors exactly
 *  what bulkUpsertProducts writes, so a re-uploaded catalog or a sku+stock feed can flag the (usually
 *  large) majority of rows that leave the product untouched. Deliberately conservative: an undefined
 *  field means a blank CSV cell ("leave unchanged", never a diff), and anything it can't compare
 *  cleanly counts as a change — a false "changed" is only mild UI clutter, a false "unchanged" would
 *  silently drop a real edit. `existingCategoryPath` is the caller-resolved root-first name chain of
 *  existing.categoryId (this module's getAncestorChain), so the compare stays pure/non-mutating. */
export function updateChangesProduct(existing: StoreProduct, input: BulkUpsertInput, existingCategoryPath: string[]): boolean {
  if (input.name !== existing.name) return true;
  if (input.price !== existing.price) return true;
  if (input.description !== undefined && input.description !== (existing.description ?? '')) return true;
  if (input.tags !== undefined && !arrEq(input.tags, existing.tags ?? [])) return true;
  if (input.categoryPath !== undefined && !arrEq(input.categoryPath, existingCategoryPath)) return true;

  if (input.variants?.length) {
    // A variant row replaces the whole matrix; product-level stock is its derived sum, so equal
    // variantStock already implies equal total — no separate scalar-stock compare needed.
    return !variantsEq(input.variants, existing.variants ?? [])
      || !mapEq(input.variantStock ?? {}, existing.variantStock ?? {})
      || !mapEq(input.variantSku ?? {}, existing.variantSku ?? {});
  }
  if (input.stock !== undefined && input.stock !== existing.stock) return true;
  if (input.sku !== undefined && input.sku !== existing.sku) return true;
  if (input.weightGrams !== undefined && input.weightGrams !== existing.weightGrams) return true;
  if (input.salePrice !== undefined) {
    const nextValue = input.salePrice > 0 && input.salePrice < input.price
      ? roundMoney(input.price - input.salePrice)
      : 0;
    const currentValue = existing.discount?.type === 'amount' ? existing.discount.value : 0;
    // A percent discount can't be equal to a ₪ one for diff purposes — treat any type change
    // as a change rather than trying to compare across shapes.
    if (existing.discount && existing.discount.type !== 'amount' && nextValue > 0) return true;
    if (nextValue !== currentValue) return true;
  }
  return false;
}

/** Re-exported from csv-bulk.ts, where it is derived from the option columns themselves. It moved
 *  there when the product form started warning on the same bound while the seller types: this
 *  module needs store-categories.ts (fs/path, Node-only), so the browser cannot import it. */
export { CSV_MAX_DIMENSIONS };
function isCsvExpandable(p: StoreProduct): boolean {
  return !!p.variants?.length && p.variants.length <= CSV_MAX_DIMENSIONS;
}

export interface FeedJsonProduct {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
  /** Grams; `0` means the seller has not stated one. A consumer of this feed sees the same
   *  distinction the rest of the system keeps — 0 is never a real parcel weight. */
  weightGrams: number;
  categoryPath: string[];
  tags: string[];
  description: string;
  variants?: Array<{ name: string; options: string[]; stock?: Record<string, number>; sku?: Record<string, string> }>;
}

/** The outbound feed's JSON shape — the same catalog data productsToCsv exports, but machine-first
 *  (nested category path + variant matrix instead of flattened combo rows). Consumed by another
 *  system that pulls this store's live inventory; kept a pure function (all data passed in) so the
 *  tokenized feed route stays a thin serializer. */
export function productsToFeedJson(products: StoreProduct[], categories: StoreCategory[]): FeedJsonProduct[] {
  return products.map((p) => {
    const chain = p.categoryId ? getAncestorChain(categories, p.categoryId) : [];
    return {
      id: p.id,
      sku: p.sku ?? '',
      name: p.name,
      price: p.price,
      stock: p.stock,
      weightGrams: p.weightGrams ?? 0,
      categoryPath: chain.map((c) => c.name),
      tags: p.tags ?? [],
      description: p.description ?? '',
      ...(p.variants?.length ? {
        variants: p.variants.map((v) => ({
          name: v.name,
          options: v.options,
          ...(p.variantStock && Object.keys(p.variantStock).length ? { stock: p.variantStock } : {}),
          ...(p.variantSku && Object.keys(p.variantSku).length ? { sku: p.variantSku } : {}),
        })),
      } : {}),
    };
  });
}

/** The product's OWN discount as an absolute price, for the export column. The store-wide sale is
 *  deliberately not folded in: it isn't a property of any single product, and re-importing a file
 *  where it had been baked into every row would freeze it into permanent per-product discounts. */
/** Grams as typed, blank when unstated — so a round-trip through the file leaves an unweighed
 *  product unweighed rather than writing a 0 the importer would have to interpret. */
function weightCell(p: StoreProduct): string {
  return p.weightGrams ? String(p.weightGrams) : '';
}

function salePriceCell(p: StoreProduct): string {
  const d = p.discount;
  if (!d) return '';
  const next = discountedPrice(p.price, d.type, d.value);
  return next > 0 && next < p.price ? String(next) : '';
}

export function productsToCsv(products: StoreProduct[], categories: StoreCategory[], lang: 'he' | 'en'): string {
  const header = CSV_FIELDS.map((f) => toCsvCell(f[lang])).join(',');
  // The "variant group" column only has to tie a product's rows together and stay unique within the
  // file (the id column is what actually matches an existing product on re-import), so use a readable
  // label — the product name, suffixed only on a name collision — instead of the opaque UUID.
  const usedGroups = new Set<string>();
  const groupLabel = (p: StoreProduct): string => {
    const base = p.name.trim() || p.slug || 'variant';
    let label = base;
    for (let n = 2; usedGroups.has(label); n++) label = `${base}-${n}`;
    usedGroups.add(label);
    return label;
  };
  const lines = products.flatMap((p) => {
    const chain = p.categoryId ? getAncestorChain(categories, p.categoryId) : [];
    const cat = [chain[0]?.name ?? '', chain[1]?.name ?? '', chain[2]?.name ?? ''];
    const shared = [
      sanitizeCsvCell(p.name),
      String(p.price),
    ];
    const tail = [
      sanitizeCsvCell(cat[0]!),
      sanitizeCsvCell(cat[1]!),
      sanitizeCsvCell(cat[2]!),
      sanitizeCsvCell((p.tags ?? []).join(', ')),
      sanitizeCsvCell(p.description ?? ''),
    ];

    const blankOptions = ['', '', '', '', '', '']; // three name/value pairs
    if (!isCsvExpandable(p)) {
      // id, sku, [name, price], stock, [category…description], group, + 3 blank option pairs
      return [[p.id, sanitizeCsvCell(p.sku ?? ''), ...shared, String(p.stock), ...tail, '', ...blankOptions, salePriceCell(p), weightCell(p)].map(toCsvCell).join(',')];
    }

    const dims = p.variants!; // 1–3 dimensions, any name
    // A readable group label ties the rows together for re-grouping; the id column (below) is what
    // actually marks every row as an update to this same product on re-import.
    const group = groupLabel(p);
    return generateCombos(dims).map((combo) => {
      const key = comboKey(combo);
      // One name/value pair per dimension slot, in the product's own dimension order; unused slots blank.
      const optionCells = Array.from({ length: CSV_MAX_DIMENSIONS }, (_, j) => {
        const dim = dims[j];
        return [sanitizeCsvCell(dim?.name ?? ''), sanitizeCsvCell(dim ? (combo[dim.name] ?? '') : '')];
      }).flat();
      return [
        p.id,
        sanitizeCsvCell(p.variantSku?.[key] ?? ''),
        ...shared,
        // BLANK for a combo with no bucket of its own, never the shared pool's number. Writing the
        // pool into each combo's own cell made the file assert a per-combo count that does not
        // exist, and re-importing it read every one of those cells back as a bucket: a product
        // with 10 units across 4 pooled combos exported four 10s and came back as 40. Blank is
        // what the importer reads as "no override" (variant-csv.ts), so an untouched export now
        // round-trips to the same product.
        p.variantStock?.[key] !== undefined ? String(p.variantStock[key]) : '',
        ...tail,
        sanitizeCsvCell(group),
        ...optionCells,
        salePriceCell(p),
        // The weight is the PRODUCT's, not the combo's, so every row of a variant group carries
        // the same number — the same treatment name/price/description already get above.
        weightCell(p),
      ].map(toCsvCell).join(',');
    });
  });
  return BOM + [header, ...lines].join('\r\n');
}
