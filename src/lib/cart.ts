import { comboKey } from './variant-combo.js';

export interface CartItem {
  cartKey: string;
  slug: string;
  name: string;
  price: number;
  image: string;
  qty: number;
  stock?: number;
  selectedVariants?: Record<string, string>;
}

interface StoreCart {
  storeName: string;
  storeSlug: string;
  items: Record<string, CartItem>;
}

export interface ActiveStoreCart {
  storeSlug: string;
  storeName: string;
  count: number;
  items: CartItem[];
}

export interface CartItemAddedDetail {
  storeSlug: string;
  storeName: string;
  item: CartItem;
}

const KEY_PREFIX = 'store_cart_v2_';

function storeKey(storeSlug: string): string {
  return `${KEY_PREFIX}${storeSlug}`;
}

export function makeCartKey(slug: string, selectedVariants?: Record<string, string>): string {
  if (!selectedVariants || !Object.keys(selectedVariants).length) return slug;
  return `${slug}__${comboKey(selectedVariants)}`;
}

function readStoreCart(storeSlug: string): StoreCart | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storeKey(storeSlug));
    return raw ? (JSON.parse(raw) as StoreCart) : null;
  } catch {
    return null;
  }
}

function writeStoreCart(cart: StoreCart): void {
  localStorage.setItem(storeKey(cart.storeSlug), JSON.stringify(cart));
  window.dispatchEvent(new CustomEvent('cart:change'));
}

export function getStoreItems(storeSlug: string): CartItem[] {
  return Object.values(readStoreCart(storeSlug)?.items ?? {});
}

export function getCartQty(
  storeSlug: string,
  slug: string,
  selectedVariants?: Record<string, string>
): number {
  const key = makeCartKey(slug, selectedVariants);
  return readStoreCart(storeSlug)?.items[key]?.qty ?? 0;
}

export function addItem(
  storeSlug: string,
  storeName: string,
  product: Pick<CartItem, 'slug' | 'name' | 'price' | 'image'> & { stock?: number },
  qty = 1,
  selectedVariants?: Record<string, string>,
  // Product cards are the only place with no add-to-cart feedback of their
  // own — the quick-view modal and the product page already show an inline
  // "added ✓" state and their own checkout button, which this preview would
  // otherwise sit on top of. Those call sites pass notify:false.
  notify = true
): void {
  const cart = readStoreCart(storeSlug) ?? { storeName, storeSlug, items: {} };
  cart.storeName = storeName;
  const key = makeCartKey(product.slug, selectedVariants);
  const prev = cart.items[key];
  const nextQty = (prev?.qty ?? 0) + qty;
  cart.items[key] = {
    cartKey: key,
    ...product,
    qty: product.stock != null ? Math.min(nextQty, Math.max(0, product.stock)) : nextQty,
    ...(selectedVariants && Object.keys(selectedVariants).length ? { selectedVariants } : {}),
  };
  writeStoreCart(cart);
  if (notify) {
    window.dispatchEvent(new CustomEvent<CartItemAddedDetail>('cart:item-added', {
      detail: { storeSlug, storeName: cart.storeName, item: cart.items[key]! },
    }));
  }
}

export function removeItem(storeSlug: string, key: string): void {
  const cart = readStoreCart(storeSlug);
  if (!cart) return;
  delete cart.items[key];
  if (Object.keys(cart.items).length === 0) {
    localStorage.removeItem(storeKey(storeSlug));
    window.dispatchEvent(new CustomEvent('cart:change'));
  } else {
    writeStoreCart(cart);
  }
}

export function setQty(storeSlug: string, key: string, qty: number): void {
  if (qty <= 0) { removeItem(storeSlug, key); return; }
  const cart = readStoreCart(storeSlug);
  if (!cart?.items[key]) return;
  cart.items[key]!.qty = qty;
  writeStoreCart(cart);
}

export function setQtyQuiet(storeSlug: string, key: string, qty: number): void {
  if (qty <= 0) { removeItem(storeSlug, key); return; }
  const cart = readStoreCart(storeSlug);
  if (!cart?.items[key]) return;
  cart.items[key]!.qty = qty;
  localStorage.setItem(storeKey(cart.storeSlug), JSON.stringify(cart));
}

export function getActiveStoreCarts(): ActiveStoreCart[] {
  if (typeof localStorage === 'undefined') return [];
  const result: ActiveStoreCart[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(KEY_PREFIX)) continue;
    try {
      const cart = JSON.parse(localStorage.getItem(key) ?? 'null') as StoreCart | null;
      if (!cart) continue;
      const items = Object.values(cart.items);
      const count = items.length;
      if (count > 0) result.push({ storeSlug: cart.storeSlug, storeName: cart.storeName, count, items });
    } catch { /* skip */ }
  }
  return result;
}

export function getCount(): number {
  return getActiveStoreCarts().reduce((s, c) => s + c.count, 0);
}

export function getSubtotal(storeSlug: string): number {
  return getStoreItems(storeSlug).reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function getGrandTotal(): number {
  return getActiveStoreCarts().reduce((sum, c) => sum + getSubtotal(c.storeSlug), 0);
}

export function syncCartImages(
  storeSlug: string,
  products: Pick<CartItem, 'slug' | 'name' | 'price' | 'image'>[]
): void {
  const cart = readStoreCart(storeSlug);
  if (!cart) return;
  let changed = false;
  const productMap = new Map(products.map((p) => [p.slug, p]));
  for (const [key, item] of Object.entries(cart.items)) {
    const p = productMap.get(item.slug);
    if (!p) continue;
    if (item.image !== p.image || item.name !== p.name || item.price !== p.price) {
      cart.items[key] = { ...item, image: p.image, name: p.name, price: p.price };
      changed = true;
    }
  }
  if (changed) writeStoreCart(cart);
}
