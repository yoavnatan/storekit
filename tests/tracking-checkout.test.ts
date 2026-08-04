// @vitest-environment jsdom
//
// `trackInitiateCheckout` — the GA4/Meta half of "the buyer reached checkout" (GO_LIVE §2.5).
//
// The arithmetic here is not decoration. `value` is the number Meta optimises a campaign against
// and the denominator of every ROAS the seller will read, and the seller pays for that campaign out
// of a budget the platform bills him for. A quantity dropped from the sum reports a 40 ₪ checkout
// as 20 ₪, and both networks then bid for the wrong shopper with his money — an error nothing on
// screen would ever show, because our own funnel counts this stage server-side and would look right
// the whole time.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trackAddToCart, trackInitiateCheckout } from '../src/lib/tracking.js';

type Pushed = Record<string, unknown>;
const fbq = vi.fn();
const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
  Promise.resolve(new Response(null, { status: 204 })));

/** The JSON body of the nth first-party analytics POST. */
const sentBody = (n = 0): Record<string, unknown> =>
  JSON.parse(String(fetchMock.mock.calls[n]![1]!.body)) as Record<string, unknown>;

beforeEach(() => {
  (window as unknown as { dataLayer: Pushed[] }).dataLayer = [];
  (window as unknown as { fbq: unknown }).fbq = fbq;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fbq.mockClear();
  fetchMock.mockClear();
});

const dl = () => (window as unknown as { dataLayer: Pushed[] }).dataLayer;
const line = (over: Partial<{ id: string; name: string; price: number; qty: number }> = {}) =>
  ({ id: 'p1', name: 'אגרטל', price: 20, qty: 1, ...over });

describe('trackInitiateCheckout', () => {
  it('sums price × qty across lines, for both networks', () => {
    trackInitiateCheckout([line({ id: 'a', price: 20, qty: 2 }), line({ id: 'b', price: 5.5, qty: 3 })]);
    expect((dl()[0]!['ecommerce'] as Pushed)['value']).toBe(56.5);
    expect(fbq).toHaveBeenCalledWith('track', 'InitiateCheckout', expect.objectContaining({
      value: 56.5, currency: 'ILS', num_items: 5, content_ids: ['a', 'b'],
    }));
  });

  it('rounds to agorot rather than emitting a float tail', () => {
    // 0.1 + 0.2 money. A value like 60.000000000000007 is not wrong by an amount anyone can
    // spend, but it is the kind of number that turns up in an ad account's own report.
    trackInitiateCheckout([line({ price: 0.1, qty: 3 }), line({ id: 'b', price: 0.2, qty: 1 })]);
    expect((dl()[0]!['ecommerce'] as Pushed)['value']).toBe(0.5);
  });

  it('carries the quantities Meta cannot read off content_ids', () => {
    trackInitiateCheckout([line({ qty: 4, price: 20 })]);
    expect(fbq.mock.calls[0]![2].contents).toEqual([{ id: 'p1', quantity: 4, item_price: 20 }]);
  });

  it('uses the GA4 event name, so the dataLayer stage matches our own funnel word', () => {
    trackInitiateCheckout([line()]);
    expect(dl()[0]!['event']).toBe('begin_checkout');
  });

  it('says nothing at all for an empty cart', () => {
    // Reached when every line in the cart belongs to a showcase store: those can never become an
    // order, so reporting them would train both networks towards a purchase we refuse by design.
    trackInitiateCheckout([]);
    expect(dl()).toHaveLength(0);
    expect(fbq).not.toHaveBeenCalled();
  });

  it('reports an item it cannot name to nobody', () => {
    // An empty catalog id means a surface that was never wired. Both networks would accept
    // content_ids:[''], match it to nothing, and file it under "events with no catalog item" —
    // a number the owner would then be debugging instead of reading.
    trackInitiateCheckout([{ ...line(), id: '' }]);
    expect(dl()).toHaveLength(0);
    expect(fbq).not.toHaveBeenCalled();
  });

  it('does not throw when no pixel is configured yet', () => {
    // The live state today: `store.config.ts` carries no GTM id and no Meta pixel, so neither
    // global exists. Every checkout on the platform runs through this line.
    (window as unknown as { dataLayer?: unknown }).dataLayer = undefined;
    (window as unknown as { fbq?: unknown }).fbq = undefined;
    expect(() => trackInitiateCheckout([line()])).not.toThrow();
  });
});

/**
 * The two identifiers `trackAddToCart` carries are different things, and conflating them is what
 * emptied the admin Data tab's "top added"/"top abandoned" lists: it sent the CATALOG id to
 * `/api/analytics/event`, which accepts only a uuid, so every add_to_cart was recorded with no
 * product at all. Nothing errored — the stage was counted, the product silently was not.
 */
describe('trackAddToCart keeps the catalog id and the product uuid apart', () => {
  const UUID = '11111111-1111-4111-8111-000000000001';

  it('sends the raw uuid to our own funnel and the catalog id to the networks', () => {
    // A variant line: the catalog id carries a combo suffix, so it is NOT uuid-shaped and would be
    // dropped by /api/analytics/event. This is exactly the case the two fields exist for.
    trackAddToCart({ id: `${UUID}-צבע-אדום`, productId: UUID, name: 'אגרטל', price: 20 }, 2);
    expect(fbq.mock.calls[0]![2].content_ids).toEqual([`${UUID}-צבע-אדום`]);
    expect(sentBody()).toEqual({ type: 'add_to_cart', productId: UUID });
  });

  it('still records the funnel stage when the catalog id is missing', () => {
    // An unwired surface must not cost the internal funnel its event — the two halves fail
    // independently because their failure modes are unrelated.
    trackAddToCart({ id: '', productId: UUID, name: 'אגרטל', price: 20 }, 1);
    expect(fbq).not.toHaveBeenCalled();
    expect(sentBody()['productId']).toBe(UUID);
  });

  it('omits the product rather than sending a blank one', () => {
    trackAddToCart({ id: UUID, name: 'אגרטל', price: 20 }, 1);
    expect(sentBody()).toEqual({ type: 'add_to_cart' });
  });
});
