import { comboKey } from './variant-combo.js';
import { roundMoney } from './money.js';
import { blockOwnStorePurchase } from './own-store-guard.js';

export interface CartItem {
  cartKey: string;
  slug: string;
  name: string;
  /** What the buyer pays — already the discounted figure (discounts.ts resolves it at the
   *  surface the item was added from, and /api/checkout re-derives it server-side). */
  price: number;
  /** The pre-discount price, present ONLY while the item is discounted. Display-only: it is
   *  what the checkout strikes through and what the "you saved" line is measured against.
   *  Never trusted for money — the charge comes from the server's own resolution, so a tampered
   *  value here can only mislead the person who tampered with it. */
  basePrice?: number;
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
  product: Pick<CartItem, 'slug' | 'name' | 'price' | 'image' | 'basePrice'> & { stock?: number },
  qty = 1,
  selectedVariants?: Record<string, string>,
  // Product cards are the only place with no add-to-cart feedback of their
  // own — the quick-view modal and the product page already show an inline
  // "added ✓" state and their own checkout button, which this preview would
  // otherwise sit on top of. Those call sites pass notify:false.
  notify = true
): void {
  // A seller may not buy from his own store — refused here, at the one write path every
  // add-to-cart surface goes through. See own-store-guard.ts for why, and for why the
  // server (not this) is the actual guarantee.
  if (blockOwnStorePurchase(storeSlug)) return;
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

/** Records what the server says is really left of one line, and clamps the stored quantity to it.
 *  Called when `/api/checkout` refuses a line for stock: the count it sends back is the live one,
 *  so keeping it means the qty stepper stops offering units that don't exist and a second press of
 *  pay has a real chance of going through. Returns the number now available (0 = nothing left).
 *
 *  A sold-out line is deliberately NOT removed — the buyer needs to see which item stopped the
 *  purchase. Its `qty` is left as it was for the same reason: the card says "sold out", and
 *  silently rewriting the number beside it would only make that harder to read. */
export function applyStockLimit(storeSlug: string, key: string, stock: number): number {
  const cart = readStoreCart(storeSlug);
  const item = cart?.items[key];
  if (!cart || !item) return 0;
  const available = Math.max(0, Math.floor(stock));
  item.stock = available;
  if (available > 0) item.qty = Math.min(item.qty, available);
  writeStoreCart(cart);
  return available;
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

/** What a line saves the buyer: the gap between the pre-discount price and what they pay,
 *  times quantity. Zero when the item carries no discount. */
export function itemSaving(item: Pick<CartItem, 'price' | 'basePrice' | 'qty'>): number {
  if (!item.basePrice || item.basePrice <= item.price) return 0;
  return roundMoney((item.basePrice - item.price) * item.qty);
}

/** Re-price every cart line from the server's answer (see /api/cart/prices). Returns true when
 *  anything actually moved, so a caller only re-renders on a real change — a cart whose prices
 *  are already current must not repaint (memory: a no-op interaction has to be invisible).
 *
 *  A `gone` line is left exactly as it is: checkout refuses it with a real message, which beats
 *  its price silently becoming something the shopper can't act on. */
/** One re-priced cart line. Carries direction and identity, not just "something moved": a price
 *  that DROPPED never needs to interrupt the buyer, and a line they aren't paying for right now
 *  never needs to interrupt them either. Without this the only safe reaction to any change was
 *  to stop everything, which turns a rare, usually-good event into friction on a normal purchase. */
export interface CartPriceChange {
  storeSlug: string;
  cartKey: string;
  slug: string;
  name: string;
  from: number;
  to: number;
  /** Set when the server's stock forced this line's QUANTITY down, carrying the new ceiling so a
   *  caller can say how many are left. Usually arrives with no price movement at all (`from ===
   *  to`), which is why it can't be inferred from the price fields. */
  clampedTo?: number;
  /** Set when the server says nothing is left of this line. The quantity is deliberately left
   *  alone (see applyStockLimit) — the buyer needs to see which item is gone, not a number
   *  quietly rewritten under it. */
  soldOut?: true;
}

export interface CartServerRow {
  storeSlug: string;
  slug: string;
  price: number;
  basePrice?: number;
  /** Units available for this exact line. Applied only when the row was matched by cart key —
   *  a row matched by slug alone can belong to a different variant combo, and its number would
   *  be the wrong ceiling for this line. */
  stock?: number;
  selectedVariants?: Record<string, string>;
  gone?: boolean;
}

/** Re-syncs every cart line with the server's answer (see /api/cart/prices): price, strikethrough,
 *  and the stock ceiling. Returns the lines that actually moved, so a caller re-renders only on a
 *  real change — a cart already current must not repaint (memory: a no-op interaction has to be
 *  invisible).
 *
 *  A `gone` line is left exactly as it is: checkout refuses it with a real message, which beats
 *  its price silently becoming something the shopper can't act on. */
export function applyServerPrices(rows: CartServerRow[]): CartPriceChange[] {
  const changes: CartPriceChange[] = [];
  const byStore = new Map<string, CartServerRow[]>();
  for (const row of rows) {
    if (row.gone) continue;
    const list = byStore.get(row.storeSlug) ?? [];
    list.push(row);
    byStore.set(row.storeSlug, list);
  }

  for (const [storeSlug, list] of byStore) {
    const cart = readStoreCart(storeSlug);
    if (!cart) continue;
    let storeChanged = false;
    const bySlug = new Map(list.map((r) => [r.slug, r]));
    // Keyed the same way the cart itself is, so a variant line is matched to ITS row and not to a
    // sibling combo's. Price is per product, so the slug map still serves as the fallback — but
    // only a key match is trusted for stock.
    const byKey = new Map(list.map((r) => [makeCartKey(r.slug, r.selectedVariants), r]));
    for (const [key, item] of Object.entries(cart.items)) {
      const exact = byKey.get(key);
      const row = exact ?? bySlug.get(item.slug);
      if (!row) continue;
      const stock = exact?.stock;
      const priceMoved = item.price !== row.price || item.basePrice !== row.basePrice;
      const soldOut = stock === 0;
      const clampedTo = stock != null && stock > 0 && item.qty > stock ? stock : undefined;
      const ceilingMoved = stock != null && item.stock !== stock;
      if (!priceMoved && !ceilingMoved && clampedTo === undefined) continue;
      const next: CartItem = { ...item, price: row.price };
      if (row.basePrice) next.basePrice = row.basePrice;
      else delete next.basePrice;
      if (stock != null) {
        next.stock = stock;
        if (clampedTo !== undefined) next.qty = clampedTo;
      }
      cart.items[key] = next;
      storeChanged = true;
      // Reported even when only the strikethrough or the ceiling moved (`from === to`) — that
      // still has to re-render. Whether anything INTERRUPTS the buyer is decided from the
      // direction and from these two flags, so a display-only correction stays silent on its own.
      changes.push({
        storeSlug, cartKey: item.cartKey, slug: item.slug, name: item.name,
        from: item.price, to: row.price,
        ...(clampedTo !== undefined ? { clampedTo } : {}),
        ...(soldOut ? { soldOut: true as const } : {}),
      });
    }
    if (storeChanged) writeStoreCart(cart);
  }
  return changes;
}

export function getGrandTotal(): number {
  return getActiveStoreCarts().reduce((sum, c) => sum + getSubtotal(c.storeSlug), 0);
}

export function syncCartImages(
  storeSlug: string,
  products: Pick<CartItem, 'slug' | 'name' | 'price' | 'image' | 'basePrice'>[]
): void {
  const cart = readStoreCart(storeSlug);
  if (!cart) return;
  let changed = false;
  const productMap = new Map(products.map((p) => [p.slug, p]));
  for (const [key, item] of Object.entries(cart.items)) {
    const p = productMap.get(item.slug);
    if (!p) continue;
    if (item.image !== p.image || item.name !== p.name || item.price !== p.price || item.basePrice !== p.basePrice) {
      // basePrice is deleted, not set to undefined, when a sale ends — otherwise the checkout
      // would keep striking through a price that is no longer a discount.
      cart.items[key] = { ...item, image: p.image, name: p.name, price: p.price };
      if (p.basePrice) cart.items[key]!.basePrice = p.basePrice;
      else delete cart.items[key]!.basePrice;
      changed = true;
    }
  }
  if (changed) writeStoreCart(cart);
}
