import crypto from 'node:crypto';
import { readProducts, writeProducts, slugify, type StoreProduct, type ProductVariant } from './store-products.js';
import { resolveOrCreateCategoryPaths, getAncestorChain, type StoreCategory } from './store-categories.js';
import { CSV_FIELDS, OPTION_SLOTS, BOM, sanitizeCsvCell, toCsvCell } from './csv-bulk.js';
import { roundMoney } from './money.js';
import { generateCombos, comboKey } from './variant-combo.js';
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
  /** Assembled by variant-csv.ts#mergeVariantGroups from a group of CSV rows. When present the row
   *  describes a variant product: `variants`/`variantStock`/`variantSku` replace the product's whole
   *  variant matrix and `stock` is the combo total. Absent = a plain single product (variant fields
   *  on an existing product are left untouched, matching the "blank cell = leave unchanged" rule). */
  variants?: ProductVariant[];
  variantStock?: Record<string, number>;
  variantSku?: Record<string, string>;
}

export interface BulkUpsertResult {
  id: string;
  /** 'not-found' means the row's id didn't match an existing product in this store — the caller pre-validates ids, so this should be unreachable in practice, but every input row always yields exactly one result (never silently skipped) so array-position pairing on the caller's side stays safe. */
  action: 'create' | 'update' | 'not-found';
  product?: StoreProduct;
}

/** One read + one write for the whole batch (vs. createProduct/updateProduct's read-modify-write per call), and an id→index map instead of a per-row findIndex scan — both matter once rows and the store's own catalog run into the hundreds/thousands. SKU uniqueness is validated by the caller (csv-bulk.ts's validateRows) before rows reach here, same as name/price. */
export async function bulkUpsertProducts(storeId: string, rows: BulkUpsertInput[]): Promise<BulkUpsertResult[]> {
  // Resolved once for the whole batch (one query, not one per row) — a row with no categoryPath
  // (blank CSV cells) resolves to null, meaning "leave unchanged".
  //
  // **It happens BEFORE the catalog is read, and that ordering is load-bearing while products still
  // live in a JSON file.** `readProducts` → mutate → `writeProducts` writes the WHOLE file, for every
  // store; an `await` between the read and the write hands the process to another request, whose own
  // write then lands on the copy this one had already read. Two imports at once (two dashboard tabs,
  // or a feed sync beside a manual upload) would each report success and one of them would vanish
  // entirely. Everything below this line stays synchronous, which is what makes the sequence atomic
  // within the process — the same guarantee `mutex.ts` gives the stock path, and it retires with it
  // once store-products moves to Postgres (DB_MIGRATION_PLAN.md §8).
  const resolvedCategoryIds = await resolveOrCreateCategoryPaths(storeId, rows.map((r) => r.categoryPath ?? []));

  const products = readProducts();
  const usedSlugs = new Set(products.filter((p) => p.storeId === storeId).map((p) => p.slug));
  const idIndex = new Map(products.map((p, idx) => [p.id, idx]));
  const results: BulkUpsertResult[] = [];

  rows.forEach((row, i) => {
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
      const idx = idIndex.get(row.id);
      const existing = idx !== undefined ? products[idx] : undefined;
      if (idx === undefined || !existing || existing.storeId !== storeId) {
        results.push({ id: row.id, action: 'not-found' });
        return;
      }
      // Blank CSV cell (row.field undefined) means "leave unchanged" — only an explicit value overwrites.
      const updated: StoreProduct = {
        ...existing,
        name: row.name,
        price: row.price,
        stock: row.stock ?? existing.stock,
        categoryId: categoryId ?? existing.categoryId,
        tags: row.tags ?? existing.tags,
        description: row.description ?? existing.description,
        sku: row.sku ?? existing.sku,
        discount: rowDiscount === undefined ? existing.discount : (rowDiscount ?? undefined),
        ...(isVariant ? { variants: row.variants, variantStock: row.variantStock ?? {}, variantSku: row.variantSku } : {}),
      };
      products[idx] = updated;
      results.push({ id: row.id, action: 'update', product: updated });
    } else {
      const base = slugify(row.name) || 'product';
      let slug = base;
      let n = 2;
      while (usedSlugs.has(slug)) { slug = `${base}-${n++}`; }
      usedSlugs.add(slug);

      const product: StoreProduct = {
        id: crypto.randomUUID(),
        storeId,
        slug,
        name: row.name,
        description: row.description ?? '',
        price: row.price,
        stock: row.stock ?? 0,
        ...(categoryId ? { categoryId } : {}),
        ...(row.tags?.length ? { tags: row.tags } : {}),
        ...(row.sku ? { sku: row.sku } : {}),
        ...(rowDiscount ? { discount: rowDiscount } : {}),
        ...(isVariant ? { variants: row.variants } : {}),
        ...(isVariant && row.variantStock && Object.keys(row.variantStock).length ? { variantStock: row.variantStock } : {}),
        ...(isVariant && row.variantSku && Object.keys(row.variantSku).length ? { variantSku: row.variantSku } : {}),
        createdAt: new Date().toISOString(),
      };
      products.push(product);
      results.push({ id: product.id, action: 'create', product });
    }
  });

  writeProducts(products);
  return results;
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

// Lives here (not csv-bulk.ts) because it needs store-categories.ts (fs/path, Node-only) to
// resolve each product's category path — csv-bulk.ts is also imported by the dashboard's
// client-side CSV preview, and a Node-only import there would crash on load in the browser.
/** How many variant dimensions the CSV can express — derived from the column set itself rather than
 *  written as a second literal `3`, since the cap IS the number of option name/value pairs in the
 *  header. A product within it round-trips as one row per combo, whatever its dimensions are named.
 *  A product past it (4+ dimensions, vanishingly rare) exports as a single flat row instead, and
 *  re-importing that row leaves its matrix untouched — store-products-import.ts reads this to tell
 *  such a seller the dashboard is the only place to edit that product's stock. */
export const CSV_MAX_DIMENSIONS = OPTION_SLOTS.length;
function isCsvExpandable(p: StoreProduct): boolean {
  return !!p.variants?.length && p.variants.length <= CSV_MAX_DIMENSIONS;
}

export interface FeedJsonProduct {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
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
      return [[p.id, sanitizeCsvCell(p.sku ?? ''), ...shared, String(p.stock), ...tail, '', ...blankOptions, salePriceCell(p)].map(toCsvCell).join(',')];
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
        String(p.variantStock?.[key] ?? p.stock),
        ...tail,
        sanitizeCsvCell(group),
        ...optionCells,
        salePriceCell(p),
      ].map(toCsvCell).join(',');
    });
  });
  return BOM + [header, ...lines].join('\r\n');
}
