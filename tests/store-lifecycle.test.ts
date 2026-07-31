import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../src/lib/stores.js';
import type { Order } from '../src/lib/orders.js';
import type { AdCampaign } from '../src/lib/ad-campaigns.js';

/** The transitions a seller can drive, and the one promise they rest on: nothing is deleted, and
 *  a store that still owes a buyer something cannot finish closing.
 *
 *  The case that motivated the whole feature is the last describe block: orders are undelivered,
 *  and meanwhile the seller wants nothing more sold. Refusing the close would have made him come
 *  back and press the button again once the parcels landed — so it defers instead.
 */

// Path-keyed so the three JSON files this touches (stores, orders, campaigns) stay separate.
const files: Record<string, unknown[]> = { stores: [], orders: [], campaigns: [] };
const keyFor = (p: string): keyof typeof files =>
  p.includes('ad-campaigns') ? 'campaigns' : p.includes('orders') ? 'orders' : 'stores';

vi.mock('node:fs', () => ({
  default: {
    readFileSync: (p: string) => JSON.stringify(files[keyFor(p)]),
    writeFileSync: (p: string, data: string) => { files[keyFor(p)] = JSON.parse(data); },
    existsSync: () => true,
    mkdirSync: () => undefined,
  },
}));

const { pauseStore, resumeStore, requestStoreClosure, settleStoreClosure, openOrderCount, countOpenOrdersByStore } =
  await import('../src/lib/store-lifecycle.js');
const { storeLifecycle } = await import('../src/lib/store-status.js');

const STORE_ID = 'st1';
const SLUG = 'my-store';

const store = (extra: Partial<Store> = {}): Store =>
  ({ id: STORE_ID, sellerId: 'sel1', slug: SLUG, name: 'My Store', tagline: '', description: '',
     colors: { primary: '#000', accent: '#111' }, createdAt: '2026-01-01T00:00:00.000Z', ...extra }) as Store;

const order = (id: string, extra: Partial<Order> = {}): Order =>
  ({ id, buyerName: 'A', buyerEmail: 'a@b.c', buyerPhone: '', buyerAddress: '',
     items: [{ productId: 'p1', productName: 'P', storeSlug: SLUG, storeName: 'My Store', price: 10, qty: 1, image: '' }],
     shippingAmount: 0, totalAmount: 10, paymentRef: id, paymentStatus: 'paid', shippingStatus: 'pending',
     createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', ...extra }) as Order;

const campaign = (id: string, extra: Partial<AdCampaign> = {}): AdCampaign =>
  ({ id, storeId: STORE_ID, storeSlug: SLUG, scope: 'store', platform: 'both', monthlyBudget: 300,
     status: 'active', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', ...extra }) as AdCampaign;

const current = (): Store => (files.stores as Store[]).find((s) => s.id === STORE_ID)!;

beforeEach(() => {
  files.stores = [store()];
  files.orders = [];
  files.campaigns = [];
});

describe('pause and resume', () => {
  it('stops selling immediately, and reopening puts it straight back', () => {
    expect(pauseStore(STORE_ID).ok).toBe(true);
    expect(storeLifecycle(current())).toBe('paused');
    expect(resumeStore(STORE_ID).ok).toBe(true);
    expect(storeLifecycle(current())).toBe('active');
  });

  // A second dashboard tab must not be able to move the moment the pause began — pausedAt is
  // what a future "paused since" reading would rest on.
  it('is idempotent: pausing twice keeps the first timestamp', () => {
    pauseStore(STORE_ID);
    const first = current().pausedAt;
    pauseStore(STORE_ID);
    expect(current().pausedAt).toBe(first);
  });

  it('never lets a seller pause-and-reopen out of an admin block', () => {
    files.stores = [store({ blocked: true })];
    expect(pauseStore(STORE_ID).ok).toBe(false);
    expect(resumeStore(STORE_ID).ok).toBe(false);
    expect(storeLifecycle(current())).toBe('blocked');
  });

  it('refuses any transition once the store is closed', () => {
    files.stores = [store({ closedAt: '2026-07-20T00:00:00.000Z' })];
    expect(pauseStore(STORE_ID).ok).toBe(false);
    expect(resumeStore(STORE_ID).ok).toBe(false);
  });
});

// "Open orders" is now a number three surfaces show — the seller's settings screen, the admin's
// store list, and the email that tells a seller what they still owe. Two implementations feed
// them (one re-reads the file per store, one groups orders the admin already loaded), so this is
// the invariant that stops them from ever answering differently.
describe('the two open-order counters agree', () => {
  it('gives the same number per store, whichever way it is asked', () => {
    files.orders = [
      order('o1'),
      order('o2', { shippingStatus: 'shipped' }),
      order('o3', { shippingStatus: 'delivered' }),
      order('o4', { paymentStatus: 'failed' }),
      order('o5', { shippingStatus: 'cancelled' }),
      // Another store's order must not land in this store's count.
      order('o6', { items: [{ productId: 'p9', productName: 'X', storeSlug: 'other-store', storeName: 'Other', price: 5, qty: 1, image: '' }] } as Partial<Order>),
    ];
    const map = countOpenOrdersByStore(files.orders as Order[]);
    expect(map.get(SLUG) ?? 0).toBe(openOrderCount(SLUG));
    expect(map.get(SLUG)).toBe(2);
    expect(map.get('other-store')).toBe(1);
  });

  // One order naming the same store twice (two lines from one shop) is ONE obligation, not two —
  // otherwise the admin's "waiting on 4 orders" would outrun the seller's list of 2.
  it('counts an order once however many of its lines belong to the store', () => {
    files.orders = [order('o1', {
      items: [
        { productId: 'p1', productName: 'A', storeSlug: SLUG, storeName: 'My Store', price: 10, qty: 1, image: '' },
        { productId: 'p2', productName: 'B', storeSlug: SLUG, storeName: 'My Store', price: 20, qty: 1, image: '' },
      ],
    } as Partial<Order>)];
    expect(countOpenOrdersByStore(files.orders as Order[]).get(SLUG)).toBe(1);
    expect(openOrderCount(SLUG)).toBe(1);
  });
});

describe('closing with nothing owed', () => {
  it('closes on the spot', () => {
    const res = requestStoreClosure(STORE_ID);
    expect(res.ok && res.state).toBe('closed');
    expect(current().closedAt).toBeTruthy();
  });

  it('keeps the store record — closing is a flag, never a delete', () => {
    requestStoreClosure(STORE_ID);
    expect((files.stores as Store[]).length).toBe(1);
    expect(current().slug).toBe(SLUG);
  });

  it('archives running boost campaigns instead of deleting them, so past spend survives', () => {
    files.campaigns = [campaign('c1'), campaign('c2', { status: 'paused' })];
    requestStoreClosure(STORE_ID);
    const rows = files.campaigns as AdCampaign[];
    expect(rows).toHaveLength(2);
    expect(rows.every((c) => c.archivedAt)).toBe(true);
    expect(rows.every((c) => c.status === 'paused')).toBe(true);
  });
});

describe('closing while orders are still open', () => {
  beforeEach(() => { files.orders = [order('o1'), order('o2', { shippingStatus: 'shipped' })]; });

  it('counts only orders that still owe the buyer something', () => {
    files.orders = [
      order('o1'),                                        // paid, pending  → open
      order('o2', { shippingStatus: 'delivered' }),       // done
      order('o3', { shippingStatus: 'cancelled' }),       // done
      order('o4', { paymentStatus: 'failed' }),           // nobody paid
    ];
    expect(openOrderCount(SLUG)).toBe(1);
  });

  // The heart of it: the seller wants no more sales, but two parcels are still out. The store
  // stops selling now, and the closure waits — rather than being refused.
  it('stops selling at once and leaves the closure pending', () => {
    const res = requestStoreClosure(STORE_ID);
    expect(res.ok && res.state).toBe('closing');
    expect(res.ok && res.openOrders).toBe(2);
    expect(current().closedAt).toBeUndefined();
    expect(current().pausedAt).toBeTruthy();
  });

  it('completes the closure by itself when the last open order is done', () => {
    requestStoreClosure(STORE_ID);
    files.orders = [order('o1', { shippingStatus: 'delivered' }), order('o2', { shippingStatus: 'shipped' })];
    expect(settleStoreClosure(SLUG)).toBeNull();          // one still in transit
    expect(storeLifecycle(current())).toBe('closing');

    files.orders = [order('o1', { shippingStatus: 'delivered' }), order('o2', { shippingStatus: 'delivered' })];
    expect(settleStoreClosure(SLUG)).not.toBeNull();
    expect(storeLifecycle(current())).toBe('closed');
  });

  it('lets the seller call the closure off, which reopens the store', () => {
    requestStoreClosure(STORE_ID);
    expect(resumeStore(STORE_ID).ok).toBe(true);
    expect(storeLifecycle(current())).toBe('active');
    // And a later settle must not resurrect the cancelled intent.
    files.orders = [];
    expect(settleStoreClosure(SLUG)).toBeNull();
    expect(storeLifecycle(current())).toBe('active');
  });

  it('does nothing for a store with no closure pending', () => {
    files.orders = [];
    expect(settleStoreClosure(SLUG)).toBeNull();
    pauseStore(STORE_ID);
    expect(settleStoreClosure(SLUG)).toBeNull();
    expect(storeLifecycle(current())).toBe('paused');
  });
});
