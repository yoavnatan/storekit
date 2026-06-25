import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
  category?: string;
  tags?: string[];
  specs?: ProductSpec[];
  variants?: ProductVariant[];
  createdAt: string;
}

function readProducts(): StoreProduct[] {
  try { return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8')) as StoreProduct[]; }
  catch { return []; }
}

function writeProducts(products: StoreProduct[]): void {
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2));
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

interface CreateProductInput {
  name: string;
  description?: string;
  price: number;
  stock?: number;
  images?: string[];
  category?: string;
  tags?: string[];
  specs?: ProductSpec[];
  variants?: ProductVariant[];
}

export function createProduct(storeId: string, { name, description = '', price, stock = 0, images, category, tags, specs, variants }: CreateProductInput): StoreProduct {
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
    ...(category ? { category } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(specs?.length ? { specs } : {}),
    ...(variants?.length ? { variants } : {}),
    createdAt: new Date().toISOString(),
  };
  products.push(product);
  writeProducts(products);
  return product;
}

export function getProductsByStoreId(storeId: string): StoreProduct[] {
  return readProducts().filter((p) => p.storeId === storeId);
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
