import crypto from 'node:crypto';
import { readProducts, writeProducts, slugify, type StoreProduct, type ProductVariant } from './store-products.js';
import { resolveOrCreateCategoryPaths, getAncestorChain, type StoreCategory } from './store-categories.js';
import { CSV_FIELDS, BOM, sanitizeCsvCell, toCsvCell } from './csv-bulk.js';
import { generateCombos, comboKey, canonicalDimName } from './variant-combo.js';
import { isColorVariant } from './color-variants.js';

export interface BulkUpsertInput {
  id?: string;
  name: string;
  price: number;
  /** Undefined = blank CSV cell = "leave unchanged" on update, defaults to 0 on create. */
  stock?: number;
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
export function bulkUpsertProducts(storeId: string, rows: BulkUpsertInput[]): BulkUpsertResult[] {
  const products = readProducts();
  const usedSlugs = new Set(products.filter((p) => p.storeId === storeId).map((p) => p.slug));
  const idIndex = new Map(products.map((p, idx) => [p.id, idx]));
  const results: BulkUpsertResult[] = [];

  // Resolved once for the whole batch (its own single read+write) rather than per row — a row
  // with no categoryPath (blank CSV cells) resolves to null here, meaning "leave unchanged".
  const resolvedCategoryIds = resolveOrCreateCategoryPaths(storeId, rows.map((r) => r.categoryPath ?? []));

  rows.forEach((row, i) => {
    const categoryId = resolvedCategoryIds[i] ?? null;
    // A variant row (assembled from a group) carries the product's whole variant matrix; only then
    // do we touch variants/variantStock/variantSku, so a plain update never clobbers them.
    const isVariant = !!row.variants?.length;
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

// Lives here (not csv-bulk.ts) because it needs store-categories.ts (fs/path, Node-only) to
// resolve each product's category path — csv-bulk.ts is also imported by the dashboard's
// client-side CSV preview, and a Node-only import there would crash on load in the browser.
/** A product whose variants are only color/size can round-trip through the two-column CSV format
 *  (expanded to one row per combo). One carrying any other dimension (material, etc.) cannot, so it
 *  exports as a single flat row — re-importing that row leaves its variant matrix untouched. */
function isCsvExpandable(p: StoreProduct): boolean {
  return !!p.variants?.length && p.variants.every((v) => isColorVariant(v.name) || canonicalDimName(v.name) === 'מידה');
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

    if (!isCsvExpandable(p)) {
      // id, sku, [name, price], stock, [category…description], group, color, size
      return [[p.id, sanitizeCsvCell(p.sku ?? ''), ...shared, String(p.stock), ...tail, '', '', ''].map(toCsvCell).join(',')];
    }

    const colorDim = p.variants!.find((v) => isColorVariant(v.name));
    const sizeDim = p.variants!.find((v) => canonicalDimName(v.name) === 'מידה');
    // A readable group label ties the rows together for re-grouping; the id column (below) is what
    // actually marks every row as an update to this same product on re-import.
    const group = groupLabel(p);
    return generateCombos(p.variants!).map((combo) => {
      const key = comboKey(combo);
      return [
        p.id,
        sanitizeCsvCell(p.variantSku?.[key] ?? ''),
        ...shared,
        String(p.variantStock?.[key] ?? p.stock),
        ...tail,
        sanitizeCsvCell(group),
        sanitizeCsvCell(colorDim ? (combo[colorDim.name] ?? '') : ''),
        sanitizeCsvCell(sizeDim ? (combo[sizeDim.name] ?? '') : ''),
      ].map(toCsvCell).join(',');
    });
  });
  return BOM + [header, ...lines].join('\r\n');
}
