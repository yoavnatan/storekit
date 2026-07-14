import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { comboKey } from './variant-combo.js';
export { LOW_STOCK_THRESHOLD } from './variant-combo.js';
import { Mutex } from './mutex.js';

const PRODUCTS_PATH = path.join(process.cwd(), 'data/store-products.json');

export interface ProductSpec {
  label: string;
  value: string;
}

export interface ProductVariant {
  name: string;
  options: string[];
}

export interface StoreProduct {
  id: string;
  storeId: string;
  slug: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  images?: string[];
  /** Points at a node in store-categories.ts's per-store tree — the leaf/level the seller assigned this product to. Matching a category also matches its descendants (see product-listing.ts). */
  categoryId?: string;
  tags?: string[];
  /** Seller-defined product code (SKU) — distinct from `id` (our internal UUID); optional, unique per store when set. */
  sku?: string;
  specs?: ProductSpec[];
  variants?: ProductVariant[];
  /** Optional per-combination stock override, keyed by variant-combo.ts#comboKey(). Combos with no entry fall back to `stock`. */
  variantStock?: Record<string, number>;
  /** Optional image override per color-variant option value (e.g. "אדום" → one of `images`) — lets the storefront swap the main photo when that color is picked instead of showing a generic gallery. Keyed by the raw option value, not a comboKey — a color choice implies the photo regardless of other dimensions (size, etc). */
  variantImages?: Record<string, string>;
  /** Admin-only kill switch (see admin-moderation.ts) — same purpose as Store.blocked
   *  but scoped to a single listing when the rest of the store is fine. 404s on its own
   *  product page, excluded from its store's grid/search/checkout. */
  blocked?: boolean;
  createdAt: string;
}

/** Exported for store-products-bulk.ts (CSV batch upsert) — same file, same read/write contract, no separate I/O path. */
export function readProducts(): StoreProduct[] {
  try { return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8')) as StoreProduct[]; }
  catch { return []; }
}

export function writeProducts(products: StoreProduct[]): void {
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2));
}

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

interface CreateProductInput {
  name: string;
  description?: string;
  price: number;
  stock?: number;
  images?: string[];
  categoryId?: string;
  tags?: string[];
  sku?: string;
  specs?: ProductSpec[];
  variants?: ProductVariant[];
  variantStock?: Record<string, number>;
  variantImages?: Record<string, string>;
}

/** True if another product in this store already uses this exact sku (case-sensitive, as typed). */
export function isSkuTaken(storeId: string, sku: string, excludeId?: string): boolean {
  return readProducts().some((p) => p.storeId === storeId && p.sku === sku && p.id !== excludeId);
}

export function createProduct(storeId: string, { name, description = '', price, stock = 0, images, categoryId, tags, sku, specs, variants, variantStock, variantImages }: CreateProductInput): StoreProduct {
  const products = readProducts();
  const storeProducts = products.filter((p) => p.storeId === storeId);
  const base = slugify(name) || 'product';
  let slug = base;
  let n = 2;
  while (storeProducts.find((p) => p.slug === slug)) { slug = `${base}-${n++}`; }

  const product: StoreProduct = {
    id: crypto.randomUUID(),
    storeId,
    slug,
    name,
    description,
    price,
    stock,
    ...(images?.length ? { images } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(sku ? { sku } : {}),
    ...(specs?.length ? { specs } : {}),
    ...(variants?.length ? { variants } : {}),
    ...(variantStock && Object.keys(variantStock).length ? { variantStock } : {}),
    ...(variantImages && Object.keys(variantImages).length ? { variantImages } : {}),
    createdAt: new Date().toISOString(),
  };
  products.push(product);
  writeProducts(products);
  return product;
}

export function getProductsByStoreId(storeId: string): StoreProduct[] {
  return readProducts().filter((p) => p.storeId === storeId);
}

/** false for an admin-blocked product (see admin-moderation.ts). Every public discovery/
 *  purchase surface must gate through this — not repeat `!product.blocked` inline — so a
 *  future call site can't forget the check the way a few already did (found in review,
 *  2026-07-14: the product page's own header-search suggestions and checkout.astro's
 *  shipping-total map both still leaked a blocked product before this consolidation). */
export function isProductVisible(product: StoreProduct): boolean {
  return !product.blocked;
}

/** getProductsByStoreId(), pre-filtered to non-blocked — the version every public listing
 *  (store grid, related products, search, "load more") should call instead of
 *  getProductsByStoreId() + an inline filter. */
export function getVisibleProductsByStoreId(storeId: string): StoreProduct[] {
  return getProductsByStoreId(storeId).filter(isProductVisible);
}

export function getProductById(id: string): StoreProduct | null {
  return readProducts().find((p) => p.id === id) ?? null;
}

export function updateProduct(id: string, updates: Partial<Omit<StoreProduct, 'id' | 'storeId' | 'createdAt'>>): StoreProduct | null {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  products[idx] = { ...products[idx]!, ...updates };
  writeProducts(products);
  return products[idx]!;
}

export function getProductBySlug(storeId: string, slug: string): StoreProduct | null {
  return readProducts().find((p) => p.storeId === storeId && p.slug === slug) ?? null;
}

export function deleteProduct(id: string): boolean {
  const products = readProducts();
  const filtered = products.filter((p) => p.id !== id);
  if (filtered.length === products.length) return false;
  writeProducts(filtered);
  return true;
}

/** Resolves which stock bucket a variant selection reads/writes: a per-combo `variantStock` entry if one exists, otherwise the shared `stock` pool (see `variantStock` doc comment above). */
function resolveStockField(product: StoreProduct, selectedVariants?: Record<string, string>): 'stock' | string {
  if (!product.variants?.length || !selectedVariants) return 'stock';
  const key = comboKey(selectedVariants);
  return product.variantStock && key in product.variantStock ? key : 'stock';
}

/** The stock number that actually governs this selection right now — same bucket `resolveStockField` would read or write. */
export function getEffectiveStock(product: StoreProduct, selectedVariants?: Record<string, string>): number {
  const field = resolveStockField(product, selectedVariants);
  return field === 'stock' ? product.stock : product.variantStock![field]!;
}

export interface StockAdjustResult {
  ok: boolean;
  /** The bucket's value immediately before this call, and after it (only meaningful when `ok`). Read from inside the same mutex-protected read-modify-write as the actual adjustment — a caller that read "before" via a separate, unlocked call could see a stale number if another request's decrement/restock interleaved between the two calls. */
  before: number;
  after: number;
}

function adjustStock(id: string, delta: number, selectedVariants: Record<string, string> | undefined): StockAdjustResult {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return { ok: false, before: 0, after: 0 };
  const product = products[idx]!;
  const field = resolveStockField(product, selectedVariants);
  const before = field === 'stock' ? product.stock : product.variantStock![field]!;
  const after = before + delta;
  if (after < 0) return { ok: false, before, after: before };

  products[idx] = field === 'stock'
    ? { ...product, stock: after }
    : { ...product, variantStock: { ...product.variantStock, [field]: after } };

  writeProducts(products);
  return { ok: true, before, after };
}

const stockMutex = new Mutex();

/** Atomically decrements stock (the matching variant-combo bucket, or the shared pool) by `qty`. `ok:false` — without writing — if that would go negative, so callers can reject the purchase instead of overselling. Serialized via a mutex so two concurrent checkouts on the same product can't both read-then-write the same stale count. */
export function decrementStock(id: string, qty: number, selectedVariants?: Record<string, string>): Promise<StockAdjustResult> {
  return stockMutex.run(() => adjustStock(id, -qty, selectedVariants));
}

/** Reverses a decrementStock — used to roll back stock already deducted for other items in the same checkout when a later item turns out to be out of stock. */
export function restockProduct(id: string, qty: number, selectedVariants?: Record<string, string>): Promise<StockAdjustResult> {
  return stockMutex.run(() => adjustStock(id, qty, selectedVariants));
}
