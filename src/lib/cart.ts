import { comboKey } from './variant-combo.js';
import { roundMoney } from './money.js';
import { blockOwnStorePurchase } from './own-store-guard.js';

export interface CartItem {
  cartKey: string;
  slug: string;
  /** The product's uuid — carried for ONE purpose: the id Google and Meta know this item by
   *  (`lib/ad-item-id.ts`), which the checkout page needs when it reports InitiateCheckout. The
   *  slug beside it cannot serve: it is unique per store, not platform-wide.
   *
   *  Optional, and every reader must cope without it. A line added before this field existed has
   *  none until the next re-price fills it in (`applyServerPrices`), and nothing here is allowed to
   *  matter enough to justify a migration for it — it is display/reporting only, never money and
   *  never identity: `/api/checkout` re-resolves every line from `storeSlug` + `slug` server-side
   *  and would ignore this even if a tampered cart supplied one. */
  productId?: string;
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
  /** The server says this line can no longer be bought — its product was deleted or hidden, or
   *  its store stopped selling (paused, closed, blocked). Set and CLEARED by applyServerPrices,
   *  so a store coming back from a pause restores its lines by itself with nothing to click.
   *
   *  The line is never removed: a buyer who added three items and finds two has no idea what
   *  happened, and may believe they bought something they did not. It stays, marked, and is left
   *  out of every total (decided with the owner 2026-07-31 — the same rule the wishlist follows).
   *  Display + totals only; /api/checkout re-derives availability server-side regardless. */
  gone?: boolean;
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
  persistStoreCart(cart);
  window.dispatchEvent(new CustomEvent('cart:change'));
}

/** Store the cart WITHOUT announcing a change — for a write that alters nothing anyone can see.
 *  `cart:change` is what redraws the header badge and the drawer, so firing it for an invisible
 *  bookkeeping field would repaint the chrome for no reason a shopper could point at (memory: a
 *  no-op interaction has to be invisible). Every write that a buyer WOULD notice goes through
 *  `writeStoreCart` above; this one has exactly one caller and its own justification. */
function persistStoreCart(cart: StoreCart): void {
  localStorage.setItem(storeKey(cart.storeSlug), JSON.stringify(cart));
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
  product: Pick<CartItem, 'slug' | 'name' | 'price' | 'image' | 'basePrice' | 'productId'> & { stock?: number },
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
      // Unavailable lines still render (they are listed, marked), but they are not part of what
      // the buyer is buying — so the header badge and the per-store count exclude them.
      const count = items.filter((i) => !i.gone).length;
      if (count > 0) result.push({ storeSlug: cart.storeSlug, storeName: cart.storeName, count, items });
    } catch { /* skip */ }
  }
  return result;
}

export function getCount(): number {
  return getActiveStoreCarts().reduce((s, c) => s + c.count, 0);
}

/** What this store's line-up costs. An unavailable line contributes nothing — showing it inside
 *  the total would quote a price checkout is going to refuse. */
export function getSubtotal(storeSlug: string): number {
  return getStoreItems(storeSlug).filter((i) => !i.gone).reduce((sum, i) => sum + i.price * i.qty, 0);
}

/** Does this store's cart still have anything the buyer can actually pay for? A group made up
 *  entirely of unavailable lines must not offer a checkout button. */
export function hasBuyableItems(storeSlug: string): boolean {
  return getStoreItems(storeSlug).some((i) => !i.gone);
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
  /** The product's uuid, resolved server-side. Backfills `CartItem.productId` on lines stored
   *  before that field existed, or rebuilt from the server cart (which does not carry it). */
  productId?: string;
  price: number;
  basePrice?: number;
  /** Units available for this exact line. Applied only when the row was matched by cart key —
   *  a row matched by slug alone can belong to a different variant combo, and its number would
   *  be the wrong ceiling for this line. */
  stock?: number;
  selectedVariants?: Record<string, string>;
  gone?: boolean;
}

/** Writes the server's availability verdict onto the stored lines — set AND cleared, so a line
 *  whose store reopened stops being marked without the buyer doing anything. Runs before the
 *  re-pricing below, which then skips the gone rows: their price is not a number anyone can act
 *  on, and re-pricing one would announce a change on a line that cannot be bought. */
function markGoneLines(rows: CartServerRow[]): void {
  const verdict = new Map<string, boolean>();
  for (const row of rows) verdict.set(`${row.storeSlug}|${row.slug}`, row.gone === true);
  const slugs = new Set(rows.map((r) => r.storeSlug));
  for (const storeSlug of slugs) {
    const cart = readStoreCart(storeSlug);
    if (!cart) continue;
    let changed = false;
    for (const item of Object.values(cart.items)) {
      const answer = verdict.get(`${storeSlug}|${item.slug}`);
      if (answer === undefined) continue;
      if (answer && !item.gone) { item.gone = true; changed = true; }
      else if (!answer && item.gone) { delete item.gone; changed = true; }
    }
    if (changed) writeStoreCart(cart);
  }
}

/**
 * Backfills `CartItem.productId` from the server's answer.
 *
 * Its own pass, deliberately kept OUT of the re-pricing loop below: that loop returns early the
 * moment nothing about a line has moved, which is the normal case and exactly the case a backfill
 * has to cover. Threading it through there would also have put a purely cosmetic field inside the
 * function that decides whether to interrupt a buyer about a price — this writes nothing anyone
 * sees, reports no change, and can never produce a re-render.
 *
 * Only ever fills a gap; an existing id is left alone, so this cannot rewrite what a page already
 * reported. Persisted silently (`persistStoreCart`): nothing about the cart a shopper can see has
 * changed, and `cart:change` would repaint the header badge and the drawer for it.
 */
function fillProductIds(rows: CartServerRow[]): void {
  const byStore = new Map<string, CartServerRow[]>();
  for (const row of rows) {
    if (!row.productId) continue;
    const list = byStore.get(row.storeSlug) ?? [];
    list.push(row);
    byStore.set(row.storeSlug, list);
  }
  for (const [storeSlug, list] of byStore) {
    const cart = readStoreCart(storeSlug);
    if (!cart) continue;
    const bySlug = new Map(list.map((r) => [r.slug, r]));
    let changed = false;
    for (const item of Object.values(cart.items)) {
      if (item.productId) continue;
      // Every row for one slug carries the same product id whatever the combo, so the slug map is
      // the right lookup here — unlike stock, which is per combo and must never be taken this way.
      const id = bySlug.get(item.slug)?.productId;
      if (!id) continue;
      item.productId = id;
      changed = true;
    }
    if (changed) persistStoreCart(cart);
  }
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
  markGoneLines(rows);
  fillProductIds(rows);
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
