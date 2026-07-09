export interface WishlistItem {
  slug: string;
  name: string;
  price: number;
  image: string;
  storeSlug: string;
  storeName: string;
  stock?: number;
}

const KEY = 'wishlist_v1';

function read(): WishlistItem[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as WishlistItem[];
  } catch {
    return [];
  }
}

function write(items: WishlistItem[]): void {
  localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent('wishlist:change'));
}

export function getWishlist(): WishlistItem[] {
  return read();
}

export function isWishlisted(slug: string): boolean {
  return read().some((i) => i.slug === slug);
}

export function addToWishlist(item: WishlistItem): void {
  const items = read();
  if (items.some((i) => i.slug === item.slug)) return;
  write([...items, item]);
}

export function removeFromWishlist(slug: string): void {
  write(read().filter((i) => i.slug !== slug));
}

export function toggleWishlist(item: WishlistItem): boolean {
  if (isWishlisted(item.slug)) {
    removeFromWishlist(item.slug);
    return false;
  }
  addToWishlist(item);
  return true;
}

export function getWishlistCount(): number {
  return read().length;
}

export function getWishlistByStore(): Map<string, { storeName: string; items: WishlistItem[] }> {
  const map = new Map<string, { storeName: string; items: WishlistItem[] }>();
  for (const item of read()) {
    const entry = map.get(item.storeSlug) ?? { storeName: item.storeName, items: [] };
    entry.items.push(item);
    map.set(item.storeSlug, entry);
  }
  return map;
}
