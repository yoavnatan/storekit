/**
 * One purchase, one card — the buyer's order list against the fact that checkout
 * writes a row per store.
 *
 * The defect these cover shipped for months and was invisible from the code:
 * `/api/checkout` creates one `orders` row per store on purpose, and the buyer's
 * dashboard rendered rows. So a basket paid for in one click came back as two
 * unrelated cards with two ids, two dates and two totals, and nothing said they
 * were the same order (user, 2026-08-05). Grouping is display-only — the rows
 * stay split, because that is what lets each seller fulfil and be paid alone.
 *
 * Money is in here too: a purchase total is the slices' own totals added up, so
 * a regression in the grouping is a wrong number on a buyer's screen.
 */
import { describe, it, expect } from 'vitest';
import { groupBuyerPurchases } from '../src/lib/buyer-purchases.js';
import { filterBuyerPurchases } from '../src/lib/buyer-orders-query.js';
import type { Order } from '../src/lib/orders.js';

type Slice = {
  id: string;
  ref?: string;
  store: string;
  status: Order['shippingStatus'];
  totalAgorot: number;
  createdAt: string;
  product?: string;
};

function order({ id, ref, store, status, totalAgorot, createdAt, product = 'פריט' }: Slice): Order {
  return {
    id,
    ...(ref ? { checkoutRef: ref } : {}),
    buyerName: 'קונה', buyerEmail: 'b@example.com', buyerPhone: '0500000000',
    buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
    items: [{ productId: `p-${id}`, productName: product, storeSlug: store, storeName: `חנות ${store}`, priceAgorot: totalAgorot, qty: 1 }],
    storeSubtotals: { [store]: { subtotalAgorot: totalAgorot, shippingAgorot: 0 } },
    shippingAgorot: 0,
    totalAgorot,
    paymentStatus: 'paid',
    shippingStatus: status,
    createdAt,
    updatedAt: createdAt,
  } as Order;
}

/** Newest-first, as `getOrdersByBuyer` hands them over. */
const TWO_STORE_ORDER = [
  order({ id: 'o2', ref: 'CK-100', store: 'beta',  status: 'pending',   totalAgorot: 4_000, createdAt: '2026-08-04T10:00:01Z', product: 'מנורה' }),
  order({ id: 'o1', ref: 'CK-100', store: 'alpha', status: 'shipped',   totalAgorot: 12_500, createdAt: '2026-08-04T10:00:00Z', product: 'כיסא' }),
];

describe('groupBuyerPurchases', () => {
  it('makes one purchase out of the rows that share a checkoutRef', () => {
    const [p, ...rest] = groupBuyerPurchases(TWO_STORE_ORDER);
    expect(rest).toHaveLength(0);
    expect(p!.ref).toBe('CK-100');
    // Oldest slice first — the caller hands rows newest-first, which is backwards
    // for the two halves of a single click.
    expect(p!.slices.map((s) => s.storeSlug)).toEqual(['alpha', 'beta']);
  });

  it('totals the purchase as the sum of its slices, to the agora', () => {
    const [p] = groupBuyerPurchases(TWO_STORE_ORDER);
    expect(p!.totalAgorot).toBe(16_500);
    expect(p!.slices.map((s) => s.totalAgorot)).toEqual([12_500, 4_000]);
  });

  it('dates the purchase by its earliest slice — one click happened at one time', () => {
    // checkout.ts writes the rows in a loop, so the later timestamps are the
    // loop, not a second purchase.
    const [p] = groupBuyerPurchases(TWO_STORE_ORDER);
    expect(p!.createdAt).toBe('2026-08-04T10:00:00Z');
  });

  it('headlines the least-advanced slice', () => {
    // The buyer is still waiting on 'pending' even though the other half shipped,
    // and that is the one the card has to lead with.
    const [p] = groupBuyerPurchases(TWO_STORE_ORDER);
    expect(p!.status).toBe('pending');
  });

  it('keeps a purchase open while ANY slice is still coming', () => {
    const [p] = groupBuyerPurchases(TWO_STORE_ORDER);
    expect(p!.awaiting).toBe(true);
  });

  it('leaves rows with no checkoutRef as separate purchases', () => {
    // Nothing writes one today, but rows predate the field — they must render
    // exactly as they did before rather than collapsing into each other.
    const rows = [
      order({ id: 'aaaaaaaa11', store: 'alpha', status: 'pending', totalAgorot: 100, createdAt: '2026-08-04T10:00:00Z' }),
      order({ id: 'bbbbbbbb22', store: 'beta',  status: 'pending', totalAgorot: 200, createdAt: '2026-08-03T10:00:00Z' }),
    ];
    const purchases = groupBuyerPurchases(rows);
    expect(purchases).toHaveLength(2);
    expect(purchases.map((p) => p.ref)).toEqual(['AAAAAAAA', 'BBBBBBBB']);
  });

  it('keeps the newest-first order it was handed', () => {
    const rows = [
      ...TWO_STORE_ORDER,
      order({ id: 'o0', ref: 'CK-099', store: 'alpha', status: 'delivered', totalAgorot: 500, createdAt: '2026-07-01T10:00:00Z' }),
    ];
    expect(groupBuyerPurchases(rows).map((p) => p.ref)).toEqual(['CK-100', 'CK-099']);
  });
});

describe('a cancelled slice is not a cancelled order', () => {
  it('ignores a cancelled slice while a live one remains', () => {
    // One store cancelled and the rest shipped is a shipped order with a refund
    // in it — showing "בוטלה" over the whole card would be a lie about the
    // parcel that is genuinely on its way.
    const [p] = groupBuyerPurchases([
      order({ id: 'o1', ref: 'CK-1', store: 'alpha', status: 'cancelled', totalAgorot: 100, createdAt: '2026-08-04T10:00:00Z' }),
      order({ id: 'o2', ref: 'CK-1', store: 'beta',  status: 'shipped',   totalAgorot: 200, createdAt: '2026-08-04T10:00:00Z' }),
    ]);
    expect(p!.status).toBe('shipped');
    expect(p!.awaiting).toBe(true);
  });

  it('reads as cancelled only when every slice is', () => {
    const [p] = groupBuyerPurchases([
      order({ id: 'o1', ref: 'CK-2', store: 'alpha', status: 'cancelled', totalAgorot: 100, createdAt: '2026-08-04T10:00:00Z' }),
      order({ id: 'o2', ref: 'CK-2', store: 'beta',  status: 'cancelled', totalAgorot: 200, createdAt: '2026-08-04T10:00:00Z' }),
    ]);
    expect(p!.status).toBe('cancelled');
    // …and nothing is coming, so it belongs in history and not in "פעילות",
    // where a bare `=== 'delivered'` split used to strand it forever.
    expect(p!.awaiting).toBe(false);
  });
});

describe('filterBuyerPurchases', () => {
  const all = groupBuyerPurchases([
    ...TWO_STORE_ORDER,
    order({ id: 'o0', ref: 'CK-099', store: 'gamma', status: 'delivered', totalAgorot: 500, createdAt: '2026-07-01T10:00:00Z', product: 'שולחן' }),
  ]);

  it('splits active from history by whether anything is still coming', () => {
    expect(filterBuyerPurchases(all, { q: '', history: false }).map((p) => p.ref)).toEqual(['CK-100']);
    expect(filterBuyerPurchases(all, { q: '', history: true }).map((p) => p.ref)).toEqual(['CK-099']);
  });

  it('searches across every slice, not just the first', () => {
    // "כיסא" is in the SECOND slice of CK-100. Searching a row at a time found
    // it; searching a purchase has to reach into all of them.
    expect(filterBuyerPurchases(all, { q: 'כיסא', history: false }).map((p) => p.ref)).toEqual(['CK-100']);
    expect(filterBuyerPurchases(all, { q: 'חנות alpha', history: false }).map((p) => p.ref)).toEqual(['CK-100']);
  });

  it('still finds a purchase by one slice\'s own order id', () => {
    // A per-store email quotes that store's row id, not the checkout ref.
    expect(filterBuyerPurchases(all, { q: 'o1', history: false }).map((p) => p.ref)).toEqual(['CK-100']);
  });

  it('matches nothing when the term is in neither', () => {
    expect(filterBuyerPurchases(all, { q: 'אופניים', history: false })).toEqual([]);
  });
});

describe('two purchases never merge into one card', () => {
  it('keeps them apart when a short checkoutRef collides across charges', () => {
    // `checkoutRef` is eight hex characters, and it now decides which rows share a
    // TOTAL — a collision would put two unrelated purchases in one card under one
    // sum. The payment ref differs per charge, so pairing them cannot.
    const a = { ...order({ id: 'x1', ref: 'CK-DUP', store: 'alpha', status: 'pending', totalAgorot: 100, createdAt: '2026-08-04T10:00:00Z' }), paymentRef: 'TX-1' };
    const b = { ...order({ id: 'x2', ref: 'CK-DUP', store: 'beta',  status: 'pending', totalAgorot: 900, createdAt: '2026-01-02T10:00:00Z' }), paymentRef: 'TX-2' };
    const purchases = groupBuyerPurchases([a, b]);
    expect(purchases).toHaveLength(2);
    expect(purchases.map((p) => p.totalAgorot)).toEqual([100, 900]);
  });

  it('still groups the rows of ONE charge, which share both refs', () => {
    const rows = [
      { ...order({ id: 'y1', ref: 'CK-OK', store: 'alpha', status: 'pending', totalAgorot: 100, createdAt: '2026-08-04T10:00:00Z' }), paymentRef: 'TX-9' },
      { ...order({ id: 'y2', ref: 'CK-OK', store: 'beta',  status: 'pending', totalAgorot: 900, createdAt: '2026-08-04T10:00:01Z' }), paymentRef: 'TX-9' },
    ];
    expect(groupBuyerPurchases(rows)).toHaveLength(1);
  });
});
