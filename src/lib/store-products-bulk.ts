import crypto from 'node:crypto';
import { readProducts, writeProducts, slugify, type StoreProduct } from './store-products.js';

export interface BulkUpsertInput {
  id?: string;
  name: string;
  price: number;
  /** Undefined = blank CSV cell = "leave unchanged" on update, defaults to 0 on create. */
  stock?: number;
  category?: string;
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

  for (const row of rows) {
    if (row.id) {
      const idx = idIndex.get(row.id);
      const existing = idx !== undefined ? products[idx] : undefined;
      if (idx === undefined || !existing || existing.storeId !== storeId) {
        results.push({ id: row.id, action: 'not-found' });
        continue;
      }
      // Blank CSV cell (row.field undefined) means "leave unchanged" — only an explicit value overwrites.
      const updated: StoreProduct = {
        ...existing,
        name: row.name,
        price: row.price,
        stock: row.stock ?? existing.stock,
        category: row.category ?? existing.category,
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
        ...(row.category ? { category: row.category } : {}),
        ...(row.tags?.length ? { tags: row.tags } : {}),
        ...(row.sku ? { sku: row.sku } : {}),
        createdAt: new Date().toISOString(),
      };
      products.push(product);
      results.push({ id: product.id, action: 'create', product });
    }
  }

  writeProducts(products);
  return results;
}
