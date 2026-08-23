// @vitest-environment jsdom
//
// `trackPurchase` — the end of the funnel, and until 2026-08-23 the one stage of it the platform
// never reported (CURRENT_TASK סשן ב׳ item 3).
//
// Why this file is not optional coverage of a display concern. Three separate things run off this
// event and all three were silently dead without it:
//   · Performance Max and Advantage+ bid TOWARDS a conversion. With the funnel ending at
//     `begin_checkout` both networks were being taught to find people who reach the payment form.
//   · Every ROAS on the platform — the seller's advertising tab, and the owner's cross-check
//     against Ads Manager (GO_LIVE §2.5 layer 5) — divides by this number.
//   · Meta's dynamic catalog ads require ViewContent + AddToCart + Purchase, each carrying
//     `content_ids` that match the feed's row ids. Two of the three were firing, and the missing
//     third is the one that stops a buyer being chased with the item they already own.
//
// So the assertions below are about money and about identity: the amount must be the SERVER's, the
// shipping must stay outside it, and the ids must be the catalog ids.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trackPurchase } from '../src/lib/tracking.js';

type Pushed = Record<string, unknown>;
const fbq = vi.fn();

beforeEach(() => {
  (window as unknown as { dataLayer: Pushed[] }).dataLayer = [];
  (window as unknown as { fbq: unknown }).fbq = fbq;
  fbq.mockClear();
});

const dl = () => (window as unknown as { dataLayer: Pushed[] }).dataLayer;
const ecom = () => dl()[0]!['ecommerce'] as Pushed;
const line = (over: Partial<{ id: string; name: string; price: number; qty: number }> = {}) =>
  ({ id: 'p1', name: 'אגרטל', price: 20, qty: 1, ...over });

describe('trackPurchase', () => {
  it('reports the value it was handed, not the sum of the lines', () => {
    // The whole point of taking `value` as an argument. The cart's own prices are a re-priced
    // ESTIMATE and the server's figure is what was charged; a sale that ended in the seconds
    // between the two makes them differ, and the charged one is the only defensible ROAS
    // numerator. If this ever starts summing the lines instead, this test is what says so.
    trackPurchase([line({ price: 20, qty: 2 })], 'ABC12345', 35, 0);
    expect(ecom()['value']).toBe(35);
    expect(fbq).toHaveBeenCalledWith('track', 'Purchase',
      expect.objectContaining({ value: 35 }), expect.anything());
  });

  it('keeps shipping beside the value and never inside it', () => {
    // Under the split model the carriage is charged to the PLATFORM's merchant account and is
    // nobody's sale (order-totals.ts#storeSliceGoodsAgorot). Folding ₪30 of it into a ₪40 order
    // would report a 75% better campaign than actually happened — worst exactly on the cheap items
    // where the fee is the larger half.
    trackPurchase([line()], 'ABC12345', 40, 30);
    expect(ecom()['value']).toBe(40);
    expect(ecom()['shipping']).toBe(30);
    // Meta has no shipping field, so the only thing that can go wrong there is the value growing.
    const metaParams = fbq.mock.calls[0]![2] as Pushed;
    expect(metaParams['value']).toBe(40);
    expect(Object.values(metaParams)).not.toContain(70);
  });

  it('carries the catalog ids both networks join the catalog on', () => {
    // The identity half. `content_ids` that do not match the feed's row ids is the documented way
    // catalog retargeting fails silently: Meta accepts the event, joins it to nothing, and the
    // shopper is simply never followed.
    trackPurchase([line({ id: 'a' }), line({ id: 'b', qty: 3 })], 'REF', 10, 0);
    expect(fbq).toHaveBeenCalledWith('track', 'Purchase', expect.objectContaining({
      content_ids: ['a', 'b'],
      contents: [{ id: 'a', quantity: 1, item_price: 20 }, { id: 'b', quantity: 3, item_price: 20 }],
      content_type: 'product',
      num_items: 4,
      currency: 'ILS',
    }), expect.anything());
    expect((ecom()['items'] as Pushed[]).map((i) => i['item_id'])).toEqual(['a', 'b']);
  });

  it('sends the checkout reference as the transaction id, once for the whole basket', () => {
    // One card entry is one conversion. Reporting per store would multiply a single sale by the
    // number of shops the buyer happened to visit — the split model makes multi-store baskets the
    // normal case, not the edge one.
    trackPurchase([line()], 'ABC12345', 20, 0);
    expect(ecom()['transaction_id']).toBe('ABC12345');
    // Also Meta's de-duplication key, so a future server-side Conversions API send of the same sale
    // is counted once rather than twice.
    expect(fbq.mock.calls[0]![3]).toEqual({ eventID: 'ABC12345' });
  });

  it('still reports the sale when no line has a catalog id', () => {
    // Deliberately the opposite of `trackInitiateCheckout`, which drops the event entirely. There
    // the value was derived FROM the lines, so no lines meant no truthful number. Here the money
    // came from the server and really moved: a conversion with a poor item breakdown is a true
    // report, and dropping it would lose the sale from ROAS altogether.
    trackPurchase([line({ id: '' })], 'REF', 99, 0);
    expect(ecom()['value']).toBe(99);
    expect(ecom()['items']).toEqual([]);
    expect(fbq).toHaveBeenCalledWith('track', 'Purchase',
      expect.objectContaining({ content_ids: [], value: 99 }), expect.anything());
  });

  it('a broken GTM container cannot break the redirect that follows it', () => {
    // `dataLayer.push` is GTM's own function once the container loads, and a tag edited in the GTM
    // UI by someone who never touches this repository throws straight back out of it. This call
    // sits one line before `window.location.href` on the checkout page, so a throw here would
    // strand a buyer who has ALREADY PAID on the payment form (lib/tracking.ts#tap).
    (window as unknown as { dataLayer: { push: () => never } }).dataLayer = {
      push: () => { throw new Error('bad tag'); },
    };
    expect(() => trackPurchase([line()], 'REF', 20, 0)).not.toThrow();
    // and the other network is still reported despite it
    expect(fbq).toHaveBeenCalled();
  });
});
