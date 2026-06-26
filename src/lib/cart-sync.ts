// Client-side module: syncs cart + wishlist with server for logged-in users.
// Loaded by BaseLayout on every page. Logic runs only when a user is logged in.

import type { CartItem } from './cart.js';
import type { WishlistItem } from './wishlist.js';
import type { UserCartData, UserStoreCart } from './user-carts.js';

declare const window: Window & {
  __sessionUserId: string;
  __pendingCartSync: 'merge' | 'replace' | '';
};

const CART_PREFIX = 'store_cart_v2_';
const WISHLIST_KEY = 'wishlist_v1';

// ── localStorage helpers ────────────────────────────────────────────────────

function readLocalCart(): Record<string, UserStoreCart> {
  const result: Record<string, UserStoreCart> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(CART_PREFIX)) continue;
    try {
      const storeSlug = key.slice(CART_PREFIX.length);
      result[storeSlug] = JSON.parse(localStorage.getItem(key) ?? '') as UserStoreCart;
    } catch { /* skip corrupt entries */ }
  }
  return result;
}

function readLocalWishlist(): WishlistItem[] {
  try { return JSON.parse(localStorage.getItem(WISHLIST_KEY) ?? '[]') as WishlistItem[]; }
  catch { return []; }
}

function writeLocalCart(cart: Record<string, UserStoreCart>): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(CART_PREFIX)) keysToRemove.push(k);
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));
  for (const [storeSlug, storeCart] of Object.entries(cart)) {
    if (Object.keys(storeCart.items).length > 0) {
      localStorage.setItem(`${CART_PREFIX}${storeSlug}`, JSON.stringify(storeCart));
    }
  }
}

function writeLocalWishlist(wishlist: WishlistItem[]): void {
  localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlist));
}

// ── Merge logic ─────────────────────────────────────────────────────────────

function mergeData(
  server: UserCartData,
  localCart: Record<string, UserStoreCart>,
  localWishlist: WishlistItem[],
): UserCartData {
  // Merge carts: server is base, local items are added (take max qty for conflicts)
  const merged: Record<string, UserStoreCart> = {};
  for (const [slug, serverStore] of Object.entries(server.cart)) {
    merged[slug] = { ...serverStore, items: { ...serverStore.items } };
  }
  for (const [slug, localStore] of Object.entries(localCart)) {
    if (!merged[slug]) {
      merged[slug] = localStore;
    } else {
      for (const [cartKey, localItem] of Object.entries(localStore.items)) {
        const existing = merged[slug]!.items[cartKey];
        merged[slug]!.items[cartKey] = existing
          ? { ...existing, qty: Math.max(existing.qty, localItem.qty) } as CartItem
          : localItem;
      }
    }
  }

  // Merge wishlists: union by slug
  const wishlistMap = new Map<string, WishlistItem>();
  for (const item of server.wishlist) wishlistMap.set(item.slug, item);
  for (const item of localWishlist) if (!wishlistMap.has(item.slug)) wishlistMap.set(item.slug, item);

  return { cart: merged, wishlist: Array.from(wishlistMap.values()) };
}

// ── API calls ────────────────────────────────────────────────────────────────

async function saveToServer(): Promise<void> {
  try {
    await fetch('/api/user-cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cart: readLocalCart(), wishlist: readLocalWishlist() }),
    });
  } catch { /* ignore network errors */ }
}

async function loadAndApply(mode: 'merge' | 'replace'): Promise<void> {
  try {
    const res = await fetch('/api/user-cart');
    if (!res.ok) return;
    const serverData = await res.json() as UserCartData;

    const finalData =
      mode === 'merge'
        ? mergeData(serverData, readLocalCart(), readLocalWishlist())
        : serverData;

    writeLocalCart(finalData.cart);
    writeLocalWishlist(finalData.wishlist);

    // If we merged, push the merged result back to server
    if (mode === 'merge') await saveToServer();

    window.dispatchEvent(new CustomEvent('cart:change'));
    window.dispatchEvent(new CustomEvent('wishlist:change'));
  } catch { /* ignore */ }
}

// ── Init ─────────────────────────────────────────────────────────────────────

const uid = window.__sessionUserId;
const pending = window.__pendingCartSync;

if (uid && pending) {
  void loadAndApply(pending);
}

if (uid) {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedSave = (): void => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void saveToServer(); }, 1200);
  };
  window.addEventListener('cart:change', debouncedSave);
  window.addEventListener('wishlist:change', debouncedSave);
}
