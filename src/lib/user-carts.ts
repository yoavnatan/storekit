import fs from 'node:fs';
import path from 'node:path';
import type { CartItem } from './cart.js';
import type { WishlistItem } from './wishlist.js';

const FILE_PATH = path.join(process.cwd(), 'data/user-carts.json');

export interface UserStoreCart {
  storeName: string;
  storeSlug: string;
  items: Record<string, CartItem>;
}

export interface UserCartData {
  cart: Record<string, UserStoreCart>;
  wishlist: WishlistItem[];
  favoriteStores?: string[];
  recentStores?: string[]; // recently-visited store slugs, newest-first (see recent-stores.ts)
}

type UserCartsFile = Record<string, UserCartData>;

function read(): UserCartsFile {
  try { return JSON.parse(fs.readFileSync(FILE_PATH, 'utf8')) as UserCartsFile; }
  catch { return {}; }
}

function write(data: UserCartsFile): void {
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
}

export function getUserCart(sellerId: string): UserCartData {
  const data = read()[sellerId];
  return data ?? { cart: {}, wishlist: [], favoriteStores: [], recentStores: [] };
}

export function getFavoriteStoresForUser(userId: string): string[] {
  return read()[userId]?.favoriteStores ?? [];
}

/** Migrate a renamed store's slug across every user's saved favorites + recent-stores so a URL
 *  change doesn't orphan them (these are stored by slug; the store page 301s old *links*, but the
 *  stored favorite/recent state must be updated too). Cart groups are transient + partly client-side,
 *  so they're intentionally left to self-heal. See stores.ts → renameStoreSlug. */
export function renameStoreSlugInUserData(oldSlug: string, newSlug: string): void {
  if (!oldSlug || oldSlug === newSlug) return;
  const all = read();
  let changed = false;
  const swap = (list: string[] | undefined): string[] | undefined => {
    if (!list || !list.includes(oldSlug)) return list;
    changed = true;
    return Array.from(new Set(list.map((s) => (s === oldSlug ? newSlug : s))));
  };
  for (const uid of Object.keys(all)) {
    const u = all[uid]!;
    u.favoriteStores = swap(u.favoriteStores);   // saved stores
    u.recentStores = swap(u.recentStores);        // recently visited
    // Wishlist items carry a denormalized storeSlug (for links + add-to-cart) — repoint it.
    if (u.wishlist?.some((i) => i.storeSlug === oldSlug)) {
      changed = true;
      u.wishlist = u.wishlist.map((i) => (i.storeSlug === oldSlug ? { ...i, storeSlug: newSlug } : i));
    }
    // The saved cart is keyed BY store slug (and carries it inside) — rekey it, merging items if the
    // buyer somehow already has a group under the new slug.
    if (u.cart?.[oldSlug]) {
      changed = true;
      const moved: UserStoreCart = { ...u.cart[oldSlug]!, storeSlug: newSlug };
      const existing = u.cart[newSlug];
      u.cart[newSlug] = existing ? { ...existing, items: { ...existing.items, ...moved.items } } : moved;
      delete u.cart[oldSlug];
    }
  }
  if (changed) write(all);
}

export function saveUserCart(sellerId: string, data: UserCartData): void {
  const all = read();
  all[sellerId] = data;
  write(all);
}
