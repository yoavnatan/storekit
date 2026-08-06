// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { addItem, applyServerPrices, applyStockLimit, getCartQty, getCount, getGrandTotal, getStoreItems, getSubtotal, hasBuyableItems, itemSaving, makeCartKey, mergeStoreCart, readStoreCartForHandoff, removeItem, setQty } from '../src/lib/cart.js';

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

// Someone else bought the last units while this buyer was at checkout. /api/checkout refuses the
// line and says how many are really left; this is what brings the cart down to that number, so a
// second press of pay isn't the same refusal again.
describe('applyStockLimit — a line that ran out under the buyer', () => {
  it('clamps the quantity to what is really left and records the new ceiling', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 10 }, 5);
    expect(applyStockLimit(STORE, PRODUCT.slug, 2)).toBe(2);
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(2);
    expect(getStoreItems(STORE)[0]!.stock).toBe(2);
  });

  it('leaves a quantity that already fits alone', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 10 }, 2);
    applyStockLimit(STORE, PRODUCT.slug, 7);
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(2);
  });

  it('keeps a sold-out line in the cart — the buyer has to see which item stopped the purchase', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 10 }, 3);
    expect(applyStockLimit(STORE, PRODUCT.slug, 0)).toBe(0);
    const items = getStoreItems(STORE);
    expect(items).toHaveLength(1);
    expect(items[0]!.stock).toBe(0);
    expect(items[0]!.qty).toBe(3); // untouched: the card says "sold out", it doesn't quietly rewrite the number beside it
  });

  it('touches only the variant combo that ran out', () => {
    const red = { Color: 'Red' };
    const blue = { Color: 'Blue' };
    addItem(STORE, 'Store', { ...PRODUCT, stock: 10 }, 4, red);
    addItem(STORE, 'Store', { ...PRODUCT, stock: 10 }, 4, blue);
    applyStockLimit(STORE, makeCartKey(PRODUCT.slug, red), 1);
    expect(getCartQty(STORE, PRODUCT.slug, red)).toBe(1);
    expect(getCartQty(STORE, PRODUCT.slug, blue)).toBe(4);
  });

  it('is a no-op for a line that is no longer in the cart', () => {
    expect(applyStockLimit(STORE, 'ghost', 5)).toBe(0);
    expect(getStoreItems(STORE)).toHaveLength(0);
  });
});

/**
 * A basket arriving from a seller's own domain (`cart-handoff.ts`, `platform-routes.ts`).
 *
 * `localStorage` is per-origin, so this is the only way a cart filled on `shop.acme.co.il` can
 * reach the checkout on `dezabin.co.il`. The merge is where the shopper either keeps what they had
 * or silently loses half of it, and neither half is visible in a diff.
 */
describe('mergeStoreCart — a cart that crossed the origin boundary', () => {
  const handoff = (over: Partial<{ qty: number; stock: number; slug: string }> = {}) => ({
    storeSlug: STORE,
    storeName: 'Store',
    items: [{
      cartKey: over.slug ?? PRODUCT.slug, slug: over.slug ?? PRODUCT.slug,
      name: PRODUCT.name, price: PRODUCT.price, image: PRODUCT.image,
      qty: over.qty ?? 1, ...(over.stock != null ? { stock: over.stock } : {}),
    }],
  });

  it('lands a basket into an origin that had none', () => {
    expect(mergeStoreCart(handoff({ qty: 3 }))).toBe(true);
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(3);
  });

  it('ADDS to what was already here — both halves are the same shopper', () => {
    // Browsed the store on the platform, followed a link onto its own domain, kept shopping. One
    // basket won and the other vanished if this were a replace.
    addItem(STORE, 'Store', PRODUCT, 2);
    mergeStoreCart(handoff({ qty: 3 }));
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(5);
  });

  it('leaves lines from other stores alone', () => {
    addItem('other-store', 'Other', PRODUCT, 1);
    mergeStoreCart(handoff({ qty: 1 }));
    expect(getCartQty('other-store', PRODUCT.slug)).toBe(1);
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(1);
  });

  it('still clamps to stock — how many units exist is not a matter of opinion', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 4 }, 3);
    mergeStoreCart(handoff({ qty: 3, stock: 4 }));
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(4);
  });

  it('is a no-op for an empty handover', () => {
    expect(mergeStoreCart({ storeSlug: STORE, storeName: 'Store', items: [] })).toBe(false);
    expect(getStoreItems(STORE)).toHaveLength(0);
  });

  it('reads back out in exactly the shape that crosses', () => {
    expect(readStoreCartForHandoff(STORE)).toBeNull();   // nothing to hand over
    addItem(STORE, 'Store', PRODUCT, 2);
    const out = readStoreCartForHandoff(STORE);
    expect(out).toMatchObject({ storeSlug: STORE, storeName: 'Store' });
    expect(out!.items).toHaveLength(1);
    // The seller's origin KEEPS its copy: a shopper who crosses to pay and presses back must find
    // the store as they left it, and the merge on the far side is additive so nothing is lost.
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(2);
  });
});

// A cart sits in localStorage for as long as the shopper leaves it there, while the seller
// keeps changing prices behind it. /api/cart/prices answers with the current figures and this
// is what writes them back — the guard against a summary that quotes one price and a checkout
// that charges another.
describe('applyServerPrices — re-pricing a cart that has gone stale', () => {
  const line = (over: Partial<{ price: number; basePrice: number; stock: number }> = {}) =>
    ({ storeSlug: STORE, slug: PRODUCT.slug, price: 50, ...over });

  it('writes a newly started sale into the stored line', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 1);
    expect(applyServerPrices([line({ price: 40, basePrice: 50 })])).toEqual([
      expect.objectContaining({ slug: PRODUCT.slug, from: 50, to: 40 }),
    ]);
    const item = getStoreItems(STORE)[0]!;
    expect(item.price).toBe(40);
    expect(item.basePrice).toBe(50);
    expect(itemSaving(item)).toBe(10);
  });

  it('clears basePrice when the sale has ENDED — otherwise the checkout keeps striking through a price that is no longer a discount', () => {
    addItem(STORE, 'Store', { ...PRODUCT, price: 40, basePrice: 50, stock: 9 }, 1);
    expect(applyServerPrices([line({ price: 50 })])).toEqual([
      expect.objectContaining({ slug: PRODUCT.slug, from: 40, to: 50 }),
    ]);
    const item = getStoreItems(STORE)[0]!;
    expect(item.price).toBe(50);
    expect(item.basePrice).toBeUndefined();
    expect(itemSaving(item)).toBe(0);
  });

  it('reports no change when the stored prices are already current, so nothing re-renders', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 1);
    expect(applyServerPrices([line()])).toEqual([]);
  });

  it('leaves a product that is gone exactly as it was — checkout refuses it with a real message', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 1);
    expect(applyServerPrices([{ storeSlug: STORE, slug: PRODUCT.slug, price: 0, gone: true }])).toEqual([]);
    expect(getStoreItems(STORE)[0]!.price).toBe(50);
  });

  it('ignores rows for a store the shopper has no cart for', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 1);
    expect(applyServerPrices([{ storeSlug: 'other-store', slug: PRODUCT.slug, price: 1 }])).toEqual([]);
    expect(getStoreItems(STORE)[0]!.price).toBe(50);
  });

  // The same answer carries stock, so most shortages are caught at a moment of attention instead
  // of at the pay button. The flags matter as much as the numbers: the checkout page reacts
  // differently to a reduced quantity than to a price move, and must never do it silently.
  it('clamps the quantity to the stock the server reports, and flags it as a clamp', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 4);
    const changes = applyServerPrices([line({ stock: 2 })]);
    expect(changes).toEqual([expect.objectContaining({ from: 50, to: 50, clampedTo: 2 })]);
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(2);
    expect(getStoreItems(STORE)[0]!.stock).toBe(2);
  });

  it('flags a sold-out line without touching its quantity', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 3);
    const changes = applyServerPrices([line({ stock: 0 })]);
    expect(changes).toEqual([expect.objectContaining({ soldOut: true })]);
    expect(changes[0]!.clampedTo).toBeUndefined();
    expect(getCartQty(STORE, PRODUCT.slug)).toBe(3);
  });

  it('reports a ceiling that moved with no price change, so the stepper stops offering units that are gone', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 1);
    const changes = applyServerPrices([line({ stock: 4 })]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.clampedTo).toBeUndefined(); // qty 1 still fits — nothing was taken from the buyer
    expect(getStoreItems(STORE)[0]!.stock).toBe(4);
  });

  it('says nothing when price AND stock are both already current', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 4 }, 1);
    expect(applyServerPrices([line({ stock: 4 })])).toEqual([]);
  });

  // A row matched by slug alone can belong to a different combo of the same product, so its stock
  // is the wrong ceiling for this line. Prices are per product and still apply.
  it('applies stock only to the line the row actually identifies, never to a sibling variant', () => {
    const red = { Color: 'Red' };
    const blue = { Color: 'Blue' };
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 3, red);
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 3, blue);
    applyServerPrices([{ storeSlug: STORE, slug: PRODUCT.slug, price: 50, stock: 1, selectedVariants: red }]);
    expect(getCartQty(STORE, PRODUCT.slug, red)).toBe(1);
    expect(getCartQty(STORE, PRODUCT.slug, blue)).toBe(3);
    expect(getStoreItems(STORE).find((i) => i.selectedVariants?.Color === 'Blue')!.stock).toBe(9);
  });

  it('still re-prices a variant line from a row that carries no variants, without inventing a ceiling for it', () => {
    const red = { Color: 'Red' };
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 3, red);
    const changes = applyServerPrices([{ storeSlug: STORE, slug: PRODUCT.slug, price: 45, stock: 1 }]);
    expect(changes).toEqual([expect.objectContaining({ from: 50, to: 45 })]);
    expect(getCartQty(STORE, PRODUCT.slug, red)).toBe(3); // the shared-pool stock is NOT this line's ceiling
    expect(getStoreItems(STORE)[0]!.stock).toBe(9);
  });
});

/** A line the buyer can no longer buy — its product was deleted or hidden, or its store stopped
 *  selling. It STAYS in the cart, marked, because silently removing an item someone chose leaves
 *  them thinking they bought something they did not. What it must never do is reach a number: a
 *  subtotal that includes it quotes a price checkout is about to refuse.
 */
describe('a line that can no longer be bought', () => {
  const gone = () => applyServerPrices([{ storeSlug: STORE, slug: PRODUCT.slug, price: 50, gone: true }]);

  it('keeps the line in the cart rather than deleting it', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 2);
    gone();
    const items = getStoreItems(STORE);
    expect(items).toHaveLength(1);
    expect(items[0]!.gone).toBe(true);
    expect(items[0]!.qty).toBe(2);
  });

  it('leaves it out of the store subtotal and the grand total', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 2);
    expect(getSubtotal(STORE)).toBe(100);
    gone();
    expect(getSubtotal(STORE)).toBe(0);
    expect(getGrandTotal()).toBe(0);
  });

  it('leaves it out of the item count the header badge shows', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 1);
    addItem(STORE, 'Store', { slug: 'other', name: 'Other', price: 20, image: 'o.png', stock: 5 }, 1);
    expect(getCount()).toBe(2);
    gone();
    expect(getCount()).toBe(1);
  });

  it('still counts the store as buyable while anything else in it can be bought', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 1);
    addItem(STORE, 'Store', { slug: 'other', name: 'Other', price: 20, image: 'o.png', stock: 5 }, 1);
    gone();
    expect(hasBuyableItems(STORE)).toBe(true);
  });

  it('reports the store as having nothing buyable once every line is gone', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 1);
    gone();
    expect(hasBuyableItems(STORE)).toBe(false);
  });

  // The requirement that motivated this: a store coming back from a pause must restore its lines
  // with nothing for the buyer to click.
  it('un-marks the line by itself once the server says it is available again', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 2);
    gone();
    expect(getSubtotal(STORE)).toBe(0);
    applyServerPrices([{ storeSlug: STORE, slug: PRODUCT.slug, price: 50 }]);
    expect(getStoreItems(STORE)[0]!.gone).toBeUndefined();
    expect(getSubtotal(STORE)).toBe(100);
    expect(getCount()).toBe(1);
  });

  // Its price is not a number anyone can act on, so a change on it must not be announced.
  it('does not report a price change on a line that cannot be bought', () => {
    addItem(STORE, 'Store', { ...PRODUCT, stock: 9 }, 1);
    expect(applyServerPrices([{ storeSlug: STORE, slug: PRODUCT.slug, price: 999, gone: true }])).toEqual([]);
    expect(getStoreItems(STORE)[0]!.price).toBe(50);
  });
});

describe('itemSaving', () => {
  it('is the gap times quantity, and zero without a discount', () => {
    expect(itemSaving({ price: 40, basePrice: 55, qty: 2 })).toBe(30);
    expect(itemSaving({ price: 40, qty: 2 })).toBe(0);
    // A basePrice at or below the price is not a saving — it must never render as one.
    expect(itemSaving({ price: 40, basePrice: 40, qty: 1 })).toBe(0);
    expect(itemSaving({ price: 40, basePrice: 30, qty: 1 })).toBe(0);
  });
});
