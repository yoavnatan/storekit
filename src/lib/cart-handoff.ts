/**
 * Moving one store's cart across the custom-domain → platform boundary.
 *
 * `platform-routes.ts` carries the decision: the store is sovereign for browsing and the platform
 * owns the transaction. That leaves exactly one thing that has to physically travel, because
 * `localStorage` is per-origin and nothing else can move it — the cart the shopper filled while
 * they were on the seller's domain.
 *
 * **It rides in the URL FRAGMENT, and that is the whole design.** A fragment is never sent to a
 * server: it does not reach our access logs, our error log, a proxy, or an analytics referrer. So
 * the shopper's basket crosses without being uploaded anywhere, no server-side handoff table has to
 * exist and expire, and no cross-origin POST has to be exempted from the CSRF gate — which would
 * have meant punching a hole in `csrf.ts` for the one route where money starts moving.
 *
 * **Everything read back out is untrusted.** A fragment is typed by whoever holds the address bar.
 * The prices in it are display-only in exactly the sense `cart.ts` already documents — `/api/checkout`
 * re-resolves every line from `storeSlug` + `slug` server-side and would ignore a tampered figure —
 * so the only job here is to make sure nothing malformed reaches the drawer's renderers. The worst
 * a crafted link can do is put items in its own author's cart.
 */
import type { CartItem } from './cart.js';

/** The fragment key. `c` for cart; short because a shopper sees this in their address bar. */
export const CART_FRAGMENT_KEY = 'c';

/** Bounds. A basket is a handful of lines; anything past these is not a shopper, and a renderer
 *  should never be asked to find out what happens at ten thousand. */
const MAX_ITEMS = 60;
const MAX_QTY = 999;
const MAX_STR = 300;

/** Control characters, written as escapes rather than typed literally: these values end up in
 *  `textContent` and in `data-` attributes, and a stray newline inside a store name is exactly the
 *  kind of thing that is invisible in a diff and only shows up in production. */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export interface HandoffCart {
  storeSlug: string;
  storeName: string;
  items: CartItem[];
}

function str(value: unknown, max = MAX_STR): string | null {
  if (typeof value !== 'string') return null;
  if (!value || value.length > max || CONTROL_CHARS.test(value)) return null;
  return value;
}

function num(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : null;
}

/** One line, or null if it is not one. Optional fields are dropped rather than defaulted — every
 *  reader in `cart.ts` already copes with their absence, and inventing a `stock` or a `basePrice`
 *  would be asserting something no one measured. */
function sanitizeItem(raw: unknown): CartItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slug = str(r.slug);
  const name = str(r.name);
  const cartKey = str(r.cartKey) ?? slug;
  const qty = num(r.qty, MAX_QTY);
  const price = num(r.price, Number.MAX_SAFE_INTEGER);
  if (!slug || !name || !cartKey || qty === null || qty < 1 || price === null) return null;

  const image = str(r.image, 2048) ?? '';
  const basePrice = num(r.basePrice, Number.MAX_SAFE_INTEGER);
  const stock = num(r.stock, Number.MAX_SAFE_INTEGER);
  const productId = str(r.productId, 64);

  let selectedVariants: Record<string, string> | undefined;
  if (r.selectedVariants && typeof r.selectedVariants === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.selectedVariants as Record<string, unknown>)) {
      const key = str(k, 80), val = str(v, 80);
      if (key && val) out[key] = val;
    }
    if (Object.keys(out).length) selectedVariants = out;
  }

  return {
    cartKey, slug, name, price, image, qty: Math.floor(qty),
    ...(productId ? { productId } : {}),
    ...(basePrice !== null ? { basePrice } : {}),
    ...(stock !== null ? { stock: Math.floor(stock) } : {}),
    ...(selectedVariants ? { selectedVariants } : {}),
  };
}

/** base64url so the value survives an address bar, a copy-paste and a mail client untouched —
 *  the same encoding `attribution.ts` uses on its cookie, and for the same reason. */
export function encodeHandoffCart(cart: HandoffCart): string {
  const json = JSON.stringify(cart);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The inverse, refusing anything that is not a cart. Never throws — a malformed fragment must
 *  leave the shopper on a working checkout with the cart they already had, not on an error page. */
export function decodeHandoffCart(value: string | null | undefined): HandoffCart | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const storeSlug = str(p.storeSlug, 120);
  const storeName = str(p.storeName, 200);
  if (!storeSlug || !storeName || !Array.isArray(p.items)) return null;

  const items = p.items.slice(0, MAX_ITEMS).map(sanitizeItem).filter((i): i is CartItem => i !== null);
  return items.length ? { storeSlug, storeName, items } : null;
}
