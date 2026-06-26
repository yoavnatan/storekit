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
  return read()[sellerId] ?? { cart: {}, wishlist: [] };
}

export function saveUserCart(sellerId: string, data: UserCartData): void {
  const all = read();
  all[sellerId] = data;
  write(all);
}
