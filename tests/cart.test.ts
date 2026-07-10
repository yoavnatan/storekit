// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { addItem, getCartQty, getStoreItems, makeCartKey, removeItem, setQty } from '../src/lib/cart.js';

const STORE = 'test-store';
const PRODUCT = { slug: 'widget', name: 'Widget', price: 50, image: 'w.png' };

beforeEach(() => {
  localStorage.clear();
});

describe('addItem stock ceiling', () => {
  it('never lets accumulated qty exceed stock, regardless of how many times add-to-cart fires', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 3 }, 1);
    addItem(STORE, 'Store', { ...PRODUCT, stock: 3 }, 1);
    addItem(STORE, 'Store', { ...PRODUCT, stock: 3 }, 1);
    addItem(STORE, 'Store', { ...PRODUCT, stock: 3 }, 1); // 4th click past stock
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(3);
  });

  it('clamps a single large qty add to the stock ceiling', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 5 }, 99);
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(5);
  });

  it('never goes negative when stock is 0', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 0 }, 1);
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(0);
  });

  it('is unbounded when stock is not provided (server enforces at checkout instead)', () => {
    addItem(STORE, 'Store', PRODUCT, 10);
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(10);
  });

  it('tracks stock ceiling independently per variant combo', () => {
    const variantsA = { Color: 'Red' };
    const variantsB = { Color: 'Blue' };
    addItem(STORE, 'Store', { ...PRODUCT, stock: 2 }, 5, variantsA);
    addItem(STORE, 'Store', { ...PRODUCT, stock: 5 }, 3, variantsB);
    expect(getCartQty(STORE, PRODUCT.slug, variantsA)).toBe(2);
    expect(getCartQty(STORE, PRODUCT.slug, variantsB)).toBe(3);
  });
});

describe('makeCartKey', () => {
  it('is stable regardless of key insertion order in selectedVariants', () => {
    const a = makeCartKey('widget', { Color: 'Red', Size: 'M' });
    const b = makeCartKey('widget', { Size: 'M', Color: 'Red' });
    expect(a).toBe(b);
  });

  it('falls back to the bare slug when there are no variants', () => {
    expect(makeCartKey('widget', {})).toBe('widget');
    expect(makeCartKey('widget', undefined)).toBe('widget');
  });
});

describe('removeItem / setQty', () => {
  it('setQty does not bypass the stock ceiling check done at addItem time (manual qty edit trusts the caller)', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 2 }, 1);
    setQty(STORE, PRODUCT.slug, 999);
    // setQty has no stock parameter — this documents current behavior: callers
    // (checkout/cart-drawer qty steppers) are responsible for clamping before calling it.
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(999);
  });

  it('removes the item entirely once qty is set to 0 or below', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 5 }, 2);
    setQty(STORE, PRODUCT.slug, 0);
    expect(getStoreItems(STORE)).toHaveLength(0);
  });

  it('removeItem drops only the targeted item, leaving siblings intact', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 5 }, 1);
    addItem(STORE, 'Store', { slug: 'other', name: 'Other', price: 10, image: 'o.png', stock: 5 }, 1);
    removeItem(STORE, PRODUCT.slug);
    const remaining = getStoreItems(STORE);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.slug).toBe('other');
  });
});
