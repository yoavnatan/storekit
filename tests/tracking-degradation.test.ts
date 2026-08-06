// @vitest-environment jsdom
//
// **The failure path of the analytics tags, not the happy path** — `tracking-checkout.test.ts`
// already covers what a correct event looks like, and every one of its assertions would keep
// passing while the bug below shipped.
//
// The bug: all four add-to-cart handlers are written
//
//     addItem(…);            // the item is now genuinely in the cart
//     trackAddToCart(…);     // ← analytics
//     updateQty(1);          // …and everything that reveals "לתשלום" comes after
//
// so anything thrown out of `trackAddToCart` leaves the buyer looking at a button that did nothing,
// with no visible way to reach checkout, on a product page that is otherwise perfectly healthy.
// And it CAN throw: once GTM's container loads, `dataLayer.push` is no longer `Array.prototype.push`
// but a function that synchronously evaluates the container's own tags and templates — code edited
// in the Google UI, by someone who never opens this repository. Same for `fbq` after `fbevents.js`
// swaps the queueing stub for `callMethod`.
//
// These tests hold the tags to the iron rule: a secondary service never sits in the buyer's path.
// They deliberately assert the *caller's* outcome — "it returned" — because that, not the event,
// is what the shopper's checkout depends on.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trackAddToCart, trackInitiateCheckout, trackViewContent } from '../src/lib/tracking.js';

const BOOM = 'GTM custom template exploded';

const reportSpy = vi.fn();
vi.mock('../src/scripts/error-reporter.js', () => ({
  reportClientError: (message: string, stack?: string) => reportSpy(message, stack),
}));

type Win = { dataLayer?: unknown; fbq?: unknown };
const win = window as unknown as Win;

const fetchOk = vi.fn((_url: string, _init?: RequestInit) =>
  Promise.resolve(new Response(null, { status: 204 })));

/** A healthy page: a real array for GTM to have replaced, a working pixel, a working fetch. */
beforeEach(() => {
  win.dataLayer = [];
  win.fbq = vi.fn();
  globalThis.fetch = fetchOk as unknown as typeof fetch;
  fetchOk.mockClear();
  reportSpy.mockClear();
  // The module caps its report at one per PAGE, and a module-level flag survives between tests in
  // one file. Re-import per test would be the alternative; asserting the cap explicitly in its own
  // test (below) and tolerating "0 or 1" elsewhere is simpler and tests the same guarantee.
});

const item = { id: 'p1', productId: '3f1b0c8e-0000-4000-8000-000000000001', name: 'אגרטל', price: 20 };

describe('a GTM container that throws', () => {
  beforeEach(() => {
    win.dataLayer = { push() { throw new Error(BOOM); } };
  });

  it('does not throw out of add-to-cart — the buyer still gets their cart and their checkout link', () => {
    expect(() => trackAddToCart(item, 2)).not.toThrow();
  });

  it('does not cost the FIRST-PARTY funnel its event', () => {
    // The two halves are independent by design (see `trackAddToCart`). A broken third-party
    // container must not also blind the seller's own dashboard — that would turn one outage into
    // two, and the internal number is the one the seller is told to trust.
    trackAddToCart(item, 1);
    expect(fetchOk).toHaveBeenCalledTimes(1);
    expect(fetchOk.mock.calls[0]![0]).toBe('/api/analytics/event');
  });

  it('does not throw out of the checkout page either', () => {
    expect(() => trackInitiateCheckout([{ ...item, qty: 1 }])).not.toThrow();
  });

  it('does not throw out of a product view', () => {
    expect(() => trackViewContent(item)).not.toThrow();
  });

  it('still fires the pixel — one dead channel must not silence the other', () => {
    const fbq = vi.fn();
    win.fbq = fbq;
    trackViewContent(item);
    expect(fbq).toHaveBeenCalledWith('track', 'ViewContent', expect.objectContaining({ content_ids: ['p1'] }));
  });
});

describe('a Meta pixel that throws', () => {
  beforeEach(() => {
    win.fbq = () => { throw new Error(BOOM); };
  });

  it('does not throw out of any of the three events', () => {
    expect(() => trackViewContent(item)).not.toThrow();
    expect(() => trackAddToCart(item, 1)).not.toThrow();
    expect(() => trackInitiateCheckout([{ ...item, qty: 1 }])).not.toThrow();
  });

  it('leaves the dataLayer event intact — it is pushed before the pixel is called', () => {
    trackViewContent(item);
    expect((win.dataLayer as Record<string, unknown>[]).length).toBe(1);
  });
});

describe('a dataLayer that is not an array', () => {
  // `window.dataLayer?.push(…)` guards a MISSING dataLayer and nothing else. An extension, or a
  // second analytics script racing ours, can leave an object there — and then `.push` is
  // `undefined` and the call is a TypeError, which optional chaining never had anything to say
  // about. This is the shape that reaches a real shopper's browser, not a contrived one.
  beforeEach(() => { win.dataLayer = {}; });

  it('does not throw', () => {
    expect(() => trackAddToCart(item, 1)).not.toThrow();
    expect(() => trackInitiateCheckout([{ ...item, qty: 1 }])).not.toThrow();
  });
});

describe('a monkey-patched fetch that throws synchronously', () => {
  // The first-party POST already had `.catch()`, which handles a REJECTED promise. An extension
  // that replaces `window.fetch` with something that throws before returning one is a different
  // path, and it was unhandled — in the middle of the add-to-cart handler.
  beforeEach(() => {
    globalThis.fetch = (() => { throw new TypeError('blocked by extension'); }) as unknown as typeof fetch;
  });

  it('does not throw out of add-to-cart', () => {
    expect(() => trackAddToCart(item, 1)).not.toThrow();
  });

  it('still reports the third-party events', () => {
    const fbq = vi.fn();
    win.fbq = fbq;
    trackAddToCart(item, 1);
    expect((win.dataLayer as Record<string, unknown>[]).length).toBe(1);
    expect(fbq).toHaveBeenCalled();
  });
});

describe('visibility of the failure', () => {
  it('reports it at most once, however many events fire', () => {
    // A broken container is one fact, and `error-reporter.ts` allows five reports per session. One
    // report per EVENT would spend the whole budget on repeats of that fact within a single product
    // page and hide every genuine error behind it — which is how a defence becomes the outage.
    win.dataLayer = { push() { throw new Error(BOOM); } };
    trackViewContent(item);
    trackAddToCart(item, 1);
    trackAddToCart(item, 1);
    trackInitiateCheckout([{ ...item, qty: 1 }]);
    expect(reportSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
