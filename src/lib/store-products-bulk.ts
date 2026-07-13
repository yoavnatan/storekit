import crypto from 'node:crypto';
import { readProducts, writeProducts, slugify, type StoreProduct } from './store-products.js';
import { resolveOrCreateCategoryPaths, getAncestorChain, type StoreCategory } from './store-categories.js';
import { CSV_FIELDS, BOM, sanitizeCsvCell, toCsvCell } from './csv-bulk.js';

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
export function productsToCsv(products: StoreProduct[], categories: StoreCategory[], lang: 'he' | 'en'): string {
  const header = CSV_FIELDS.map((f) => toCsvCell(f[lang])).join(',');
  const lines = products.map((p) => {
    const chain = p.categoryId ? getAncestorChain(categories, p.categoryId) : [];
    return [
      p.id,
      sanitizeCsvCell(p.sku ?? ''),
      sanitizeCsvCell(p.name),
      String(p.price),
      String(p.stock),
      sanitizeCsvCell(chain[0]?.name ?? ''),
      sanitizeCsvCell(chain[1]?.name ?? ''),
      sanitizeCsvCell(chain[2]?.name ?? ''),
      sanitizeCsvCell((p.tags ?? []).join(', ')),
      sanitizeCsvCell(p.description ?? ''),
    ].map(toCsvCell).join(',');
  });
  return BOM + [header, ...lines].join('\r\n');
}
