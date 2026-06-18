/**
 * CART — client-side shopping cart stored in localStorage.
 *
 * Kept framework-free so it works on any Astro page. Other scripts can
 * subscribe to the custom 'cart:change' event on `window` to update UI
 * (e.g. the header badge and the cart drawer).
 *
 * Cart shape: { [slug]: { slug, name, price, image, qty } }
 */

const KEY = 'store_cart_v1';

function read() {
  if (typeof localStorage === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function write(cart) {
  localStorage.setItem(KEY, JSON.stringify(cart));
  window.dispatchEvent(new CustomEvent('cart:change', { detail: cart }));
}

export function getCart() {
  return read();
}

export function getItems() {
  return Object.values(read());
}

export function addItem(product, qty = 1) {
  const cart = read();
  const existing = cart[product.slug];
  cart[product.slug] = {
    slug: product.slug,
    name: product.name,
    price: product.price,
    image: product.image,
    qty: (existing ? existing.qty : 0) + qty,
  };
  write(cart);
}

export function setQty(slug, qty) {
  const cart = read();
  if (!cart[slug]) return;
  if (qty <= 0) delete cart[slug];
  else cart[slug].qty = qty;
  write(cart);
}

export function removeItem(slug) {
  const cart = read();
  delete cart[slug];
  write(cart);
}

export function clearCart() {
  write({});
}

export function getCount() {
  return getItems().reduce((sum, i) => sum + i.qty, 0);
}

export function getSubtotal() {
  return getItems().reduce((sum, i) => sum + i.price * i.qty, 0);
}
