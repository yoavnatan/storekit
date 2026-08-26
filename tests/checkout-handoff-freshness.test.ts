// @vitest-environment jsdom
/**
 * The cart a checkout link CARRIES must be the cart that exists when it is pressed.
 *
 * On a seller's verified custom domain the basket lives in that domain's localStorage, which the
 * platform's `/checkout` cannot read — so it travels in the link's URL fragment
 * (`custom-domain-links.ts#platformHref`, `cart-handoff.ts`). The fragment is built when the link
 * is REWRITTEN, and a static link is rewritten exactly once, at load.
 *
 * That made the whole buy path on a custom domain wrong in the ordinary case, not an exotic one:
 * `#to-checkout-btn` and `#sticky-to-checkout-btn` are in the DOM from the first paint (hidden) and
 * are revealed BY add-to-cart, so they were always stamped with the empty basket the shopper landed
 * with. Land → add → pay → arrive at a checkout with nothing on it, and no error anywhere, because
 * every piece was individually correct — the external-seam class (memory
 * `project_feed_silent_rejection_class`).
 *
 * These tests are about the JOIN, so they assert on what the link would actually navigate to.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { refreshCheckoutCartFragment, type PlatformBoundary } from '../src/lib/custom-domain-links.js';
import { addItem } from '../src/lib/cart.js';
import { decodeHandoffCart, CART_FRAGMENT_KEY } from '../src/lib/cart-handoff.js';

const PLATFORM = 'https://dezabin.co.il';
const SLUG = 'acme';
const BOUNDARY: PlatformBoundary = { origin: PLATFORM, handoff: 'tok', handoffParam: 'h' };

/** A link as `cross()` leaves it: absolute, on the platform, carrying the basket at rewrite time. */
function crossedCheckoutLink(fragment = ''): HTMLAnchorElement {
  const a = document.createElement('a');
  a.setAttribute('href', `${PLATFORM}/checkout?store=${SLUG}&h=tok${fragment}`);
  document.body.append(a);
  return a;
}

function cartOn(a: HTMLAnchorElement) {
  const hash = new URL(a.getAttribute('href')!).hash.replace(/^#/, '');
  return decodeHandoffCart(new URLSearchParams(hash).get(CART_FRAGMENT_KEY));
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('refreshCheckoutCartFragment', () => {
  it('carries an item added AFTER the link was stamped', () => {
    const a = crossedCheckoutLink(); // stamped while the basket was empty — the reveal-after-add case
    addItem(SLUG, 'Acme', { slug: 'p', productId: 'p1', name: 'מוצר', price: 100, image: '' }, 2, undefined, false);

    expect(cartOn(a)).toBeNull();
    refreshCheckoutCartFragment(a, SLUG, BOUNDARY);

    const carried = cartOn(a);
    expect(carried?.storeSlug).toBe(SLUG);
    expect(Object.values(carried!.items)).toHaveLength(1);
    expect(Object.values(carried!.items)[0]!.qty).toBe(2);
  });

  it('replaces a STALE fragment rather than leaving the older basket on the link', () => {
    addItem(SLUG, 'Acme', { slug: 'p', productId: 'p1', name: 'מוצר', price: 100, image: '' }, 1, undefined, false);
    const a = crossedCheckoutLink();
    refreshCheckoutCartFragment(a, SLUG, BOUNDARY);
    const before = cartOn(a);

    addItem(SLUG, 'Acme', { slug: 'q', productId: 'p2', name: 'שני', price: 50, image: '' }, 1, undefined, false);
    refreshCheckoutCartFragment(a, SLUG, BOUNDARY);

    expect(Object.values(before!.items)).toHaveLength(1);
    expect(Object.values(cartOn(a)!.items)).toHaveLength(2);
  });

  it('empties the fragment when the basket was emptied — never re-sends a cart that is gone', () => {
    addItem(SLUG, 'Acme', { slug: 'p', productId: 'p1', name: 'מוצר', price: 100, image: '' }, 1, undefined, false);
    const a = crossedCheckoutLink();
    refreshCheckoutCartFragment(a, SLUG, BOUNDARY);
    expect(cartOn(a)).not.toBeNull();

    localStorage.clear();
    refreshCheckoutCartFragment(a, SLUG, BOUNDARY);
    expect(a.getAttribute('href')).not.toContain('#');
  });

  it('leaves the identity carry-over and the store intent alone', () => {
    addItem(SLUG, 'Acme', { slug: 'p', productId: 'p1', name: 'מוצר', price: 100, image: '' }, 1, undefined, false);
    const a = crossedCheckoutLink();
    refreshCheckoutCartFragment(a, SLUG, BOUNDARY);

    const url = new URL(a.getAttribute('href')!);
    expect(url.searchParams.get('h')).toBe('tok');
    expect(url.searchParams.get('store')).toBe(SLUG);
    expect(url.origin).toBe(PLATFORM);
  });

  it('touches nothing it does not own', () => {
    addItem(SLUG, 'Acme', { slug: 'p', productId: 'p1', name: 'מוצר', price: 100, image: '' }, 1, undefined, false);

    // Root-relative — never crossed, so it is a same-origin navigation with no use for a basket in
    // its URL, and putting one there would leak the cart into the address bar.
    const relative = document.createElement('a');
    relative.setAttribute('href', '/checkout?store=acme');
    refreshCheckoutCartFragment(relative, SLUG, BOUNDARY);
    expect(relative.getAttribute('href')).toBe('/checkout?store=acme');

    // A platform link that is not the checkout.
    const other = document.createElement('a');
    other.setAttribute('href', `${PLATFORM}/cart`);
    refreshCheckoutCartFragment(other, SLUG, BOUNDARY);
    expect(other.getAttribute('href')).toBe(`${PLATFORM}/cart`);

    // Somebody else's origin, even at /checkout — this function may only ever stamp OUR boundary.
    const foreign = document.createElement('a');
    foreign.setAttribute('href', 'https://evil.example/checkout');
    refreshCheckoutCartFragment(foreign, SLUG, BOUNDARY);
    expect(foreign.getAttribute('href')).toBe('https://evil.example/checkout');

    // No boundary at all: we are on the platform, the cart is same-origin, nothing travels.
    const onPlatform = crossedCheckoutLink();
    refreshCheckoutCartFragment(onPlatform, SLUG, undefined);
    expect(onPlatform.getAttribute('href')).not.toContain('#');
  });

  it('never throws on a malformed href — a bad link must not break the page it sits on', () => {
    const broken = document.createElement('a');
    broken.setAttribute('href', 'http://[not a url');
    expect(() => refreshCheckoutCartFragment(broken, SLUG, BOUNDARY)).not.toThrow();
  });
});
