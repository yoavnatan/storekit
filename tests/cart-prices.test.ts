// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The stored cart is a list of intents, never a price lock — and /api/checkout charges what it
 *  resolves itself, silently. These cover the gap that opens while a tab sits: a re-price must
 *  run again when attention returns and on demand before charging, without polling in between
 *  and without spending an interruption on a change that costs the buyer nothing. */

const STORE = 'test-store';
const PRODUCT = { slug: 'widget', name: 'Widget', price: 100, image: 'w.png' };

/** Fresh module instances per test — the freshness stamp and the listener list are module state. */
async function load() {
  vi.resetModules();
  const cart = await import('../src/lib/cart.js');
  const prices = await import('../src/lib/cart-prices.js');
  return { ...cart, ...prices };
}

function priceReply(price: number, basePrice?: number) {
  return {
    ok: true,
    json: async () => ({
      ok: true,
      items: [{ storeSlug: STORE, slug: PRODUCT.slug, price, ...(basePrice ? { basePrice } : {}) }],
    }),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-29T10:00:00Z'));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('refreshCartPrices freshness', () => {
  it('does not re-request while the last answer is still fresh', async () => {
    const m = await load();
    m.addItem(STORE, 'Store', { ...PRODUCT, price: 80, basePrice: 100 }, 1);
    fetchMock.mockResolvedValue(priceReply(80, 100));

    await m.refreshCartPrices();
    vi.setSystemTime(new Date('2026-07-29T10:00:30Z')); // 30s later
    await m.refreshCartPrices();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-prices once the window has passed, and reports what moved', async () => {
    const m = await load();
    m.addItem(STORE, 'Store', { ...PRODUCT, price: 80, basePrice: 100 }, 1);
    fetchMock.mockResolvedValue(priceReply(80, 100));
    await m.refreshCartPrices();

    // An hour of an abandoned tab, and the sale ended meanwhile.
    vi.setSystemTime(new Date('2026-07-29T11:00:00Z'));
    fetchMock.mockResolvedValue(priceReply(100));
    expect(await m.refreshCartPrices()).toEqual([
      expect.objectContaining({ slug: PRODUCT.slug, from: 80, to: 100 }),
    ]);

    const [item] = m.getStoreItems(STORE);
    expect(item!.price).toBe(100);
    expect(item!.basePrice).toBeUndefined(); // no strikethrough over a price that is no discount
  });

  it('maxAge 0 forces a request even seconds after the last one (the pay-button check)', async () => {
    const m = await load();
    m.addItem(STORE, 'Store', { ...PRODUCT, price: 80, basePrice: 100 }, 1);
    fetchMock.mockResolvedValue(priceReply(80, 100));
    await m.refreshCartPrices();

    vi.setSystemTime(new Date('2026-07-29T10:00:05Z'));
    fetchMock.mockResolvedValue(priceReply(100));
    expect(await m.refreshCartPrices({ maxAge: 0 })).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(m.getStoreItems(STORE)[0]!.price).toBe(100);
  });

  it('a failed request still stamps freshness, so an offline tab does not hammer', async () => {
    const m = await load();
    m.addItem(STORE, 'Store', PRODUCT, 1);
    fetchMock.mockRejectedValue(new Error('offline'));

    expect(await m.refreshCartPrices()).toEqual([]);
    expect(await m.refreshCartPrices()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(m.getStoreItems(STORE)[0]!.price).toBe(100); // stored price left alone
  });

  it('gives up on a check that hangs, so it can never stall the pay button', async () => {
    const m = await load();
    m.addItem(STORE, 'Store', PRODUCT, 1);
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));

    const check = m.refreshCartPrices({ maxAge: 0 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await check).toEqual([]); // caller carries on; the server re-derives before charging
  });

  it('an empty cart never reaches the network', async () => {
    const m = await load();
    expect(await m.refreshCartPrices()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('hasIncrease — what is worth interrupting a purchase for', () => {
  const change = (over: Record<string, unknown>) =>
    ({ storeSlug: STORE, cartKey: PRODUCT.slug, slug: PRODUCT.slug, name: 'Widget', from: 100, to: 100, ...over }) as never;

  it('a price that went UP on a selected line stops the charge', async () => {
    const m = await load();
    expect(m.hasIncrease([change({ from: 80, to: 100 })])).toBe(true);
  });

  it('a price that DROPPED never stops anything — the buyer pays less than the summary promised', async () => {
    const m = await load();
    expect(m.hasIncrease([change({ from: 100, to: 80 })])).toBe(false);
  });

  it('a rise on a line the buyer left unticked does not stop their order', async () => {
    const m = await load();
    const buying = (c: { cartKey: string }) => c.cartKey === 'other-item';
    expect(m.hasIncrease([change({ from: 80, to: 100 })], buying)).toBe(false);
    expect(m.hasIncrease([change({ cartKey: 'other-item', from: 80, to: 100 })], buying)).toBe(true);
  });

  it('a strikethrough that moved at an unchanged price is display-only, never an interruption', async () => {
    const m = await load();
    expect(m.hasIncrease([change({ from: 100, to: 100 })])).toBe(false);
  });

  // A stock shortage must not ride on the price channel: it arrives with the price unchanged, and
  // the buyer's own quantity has just been reduced — a different reaction from "re-read the total".
  it('a stock correction is not a price increase, and does not use that channel', async () => {
    const m = await load();
    expect(m.hasIncrease([change({ clampedTo: 1 })])).toBe(false);
    expect(m.hasIncrease([change({ soldOut: true })])).toBe(false);
  });

  it('stockCorrections picks out the sold-out and clamped lines, scoped to what is being bought', async () => {
    const m = await load();
    const clamped = change({ clampedTo: 1 });
    const soldOut = change({ cartKey: 'gone-item', soldOut: true });
    const priceOnly = change({ cartKey: 'other-item', from: 80, to: 100 });
    expect(m.stockCorrections([clamped, soldOut, priceOnly])).toEqual([clamped, soldOut]);
    const buying = (c: { cartKey: string }) => c.cartKey === PRODUCT.slug;
    expect(m.stockCorrections([clamped, soldOut], buying)).toEqual([clamped]);
  });
});

describe('watchCartPrices', () => {
  function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('re-prices when the shopper comes back to a tab left open, and notifies every surface', async () => {
    const m = await load();
    m.addItem(STORE, 'Store', { ...PRODUCT, price: 80, basePrice: 100 }, 1);
    fetchMock.mockResolvedValue(priceReply(80, 100));
    await m.refreshCartPrices();

    const drawer = vi.fn();
    const summary = vi.fn();
    m.watchCartPrices(drawer);
    m.watchCartPrices(summary);

    setHidden(true);
    vi.setSystemTime(new Date('2026-07-29T11:00:00Z')); // an hour away; the sale ended
    fetchMock.mockResolvedValue(priceReply(100));
    setHidden(false);
    await vi.waitFor(() => expect(drawer).toHaveBeenCalled());

    expect(summary).toHaveBeenCalledTimes(1);
    expect(drawer.mock.calls[0]![0]).toEqual([expect.objectContaining({ from: 80, to: 100 })]);
    expect(m.getStoreItems(STORE)[0]!.price).toBe(100);
  });

  it('announces one return once, even when the browser fires two events for it', async () => {
    const m = await load();
    m.addItem(STORE, 'Store', { ...PRODUCT, price: 80, basePrice: 100 }, 1);
    fetchMock.mockResolvedValue(priceReply(80, 100));
    await m.refreshCartPrices();

    const onChange = vi.fn();
    m.watchCartPrices(onChange);

    vi.setSystemTime(new Date('2026-07-29T11:00:00Z'));
    fetchMock.mockResolvedValue(priceReply(100));
    // A bfcache restore: pageshow and visibilitychange for a single return.
    const evt = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(evt, 'persisted', { value: true });
    window.dispatchEvent(evt);
    setHidden(false);

    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledTimes(1); // one event, one toast
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stays silent when nothing moved — no re-render on a return visit', async () => {
    const m = await load();
    m.addItem(STORE, 'Store', PRODUCT, 1);
    fetchMock.mockResolvedValue(priceReply(100));
    await m.refreshCartPrices();

    const onChange = vi.fn();
    m.watchCartPrices(onChange);

    vi.setSystemTime(new Date('2026-07-29T11:00:00Z'));
    setHidden(false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(onChange).not.toHaveBeenCalled();
  });
});
