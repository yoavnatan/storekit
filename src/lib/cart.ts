export interface CartItem {
  slug: string;
  name: string;
  price: number;
  image: string;
  qty: number;
}

type Cart = Record<string, CartItem>;

const KEY = 'store_cart_v1';

function read(): Cart {
  if (typeof localStorage === 'undefined') return {};
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? {}) as Cart;
  } catch {
    return {};
  }
}

function write(cart: Cart): void {
  localStorage.setItem(KEY, JSON.stringify(cart));
  window.dispatchEvent(new CustomEvent('cart:change', { detail: cart }));
}

export function getCart(): Cart {
  return read();
}

export function getItems(): CartItem[] {
  return Object.values(read());
}

export function addItem(product: Pick<CartItem, 'slug' | 'name' | 'price' | 'image'>, qty = 1): void {
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

export function setQty(slug: string, qty: number): void {
  const cart = read();
  if (!cart[slug]) return;
  if (qty <= 0) delete cart[slug];
  else cart[slug].qty = qty;
  write(cart);
}

export function removeItem(slug: string): void {
  const cart = read();
  delete cart[slug];
  write(cart);
}

export function clearCart(): void {
  write({});
}

export function getCount(): number {
  return getItems().reduce((sum, i) => sum + i.qty, 0);
}

export function getSubtotal(): number {
  return getItems().reduce((sum, i) => sum + i.price * i.qty, 0);
}
