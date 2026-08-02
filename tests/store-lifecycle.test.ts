import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { Order } from '../src/lib/orders.js';

/** The transitions a seller can drive, and the one promise they rest on: nothing is deleted, and
 *  a store that still owes a buyer something cannot finish closing.
 *
 *  The case that motivated the whole feature is the last describe block: orders are undelivered,
 *  and meanwhile the seller wants nothing more sold. Refusing the close would have made him come
 *  back and press the button again once the parcels landed — so it defers instead.
 *
 *  **Half of this file reads Postgres and half still reads JSON, on purpose.** Stores moved in
 *  stage 2 and orders followed with the money (DB_MIGRATION_PLAN.md §8); ad campaigns have not.
 *  So two of the three are real rows and the campaigns stay behind the file mock — which is
 *  exactly the state the application itself is in mid-migration, and the reason the mock below has
 *  to delegate anything it does not own to the real `fs` instead of answering for every path: the
 *  test database is loaded from a file too, and a mock that swallowed that read reported a broken
 *  schema rather than a mocked one.
 *
 *  `openOrderCount` is a COUNT query now, so the orders it counts have to exist as rows —
 *  `writeOrders` below is what puts them there, and it is the only reason this file talks SQL.
 */
const { pauseStore, resumeStore, requestStoreClosure, settleStoreClosure, openOrderCount, countOpenOrdersByStore } =
  await import('../src/lib/store-lifecycle.js');
const { storeLifecycle } = await import('../src/lib/store-status.js');
const { getStoreById, updateStore } = await import('../src/lib/stores.js');
const { query } = await import('../src/lib/db.js');

const STORE_ID = '22222222-2222-4222-8222-0000000000f1';
const SELLER_ID = '11111111-1111-4111-8111-000000000001';
const SLUG = 'my-store';

/** A stable uuid per short test name, so `order('o1')` still reads as `o1` while the column
 *  gets the uuid it requires. */
const ORDER_IDS = new Map<string, string>();
const orderId = (name: string): string => {
  if (!ORDER_IDS.has(name)) ORDER_IDS.set(name, crypto.randomUUID());
  return ORDER_IDS.get(name)!;
};

const order = (name: string, extra: Partial<Order> = {}): Order =>
  ({ id: orderId(name), buyerName: 'A', buyerEmail: 'a@b.c', buyerPhone: '', buyerAddress: '',
     items: [{ productId: 'p1', productName: 'P', storeSlug: SLUG, storeName: 'My Store', priceAgorot: 10, qty: 1, image: '' }],
     shippingAgorot: 0, totalAgorot: 10, paymentRef: orderId(name), paymentStatus: 'paid', shippingStatus: 'pending',
     createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', ...extra }) as Order;

/** A boost campaign of this store's, as a row. Closing the store has to ARCHIVE these rather than
 *  delete them: the spend they accrued is part of figures already reported (ad-campaigns.ts). */
async function seedCampaign(status: 'active' | 'paused' = 'active'): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO ad_campaigns (id, store_id, store_slug, scope, platform, monthly_budget_agorot, status)
     VALUES ($1, $2, $3, 'store', 'both', 30000, $4)`,
    [id, STORE_ID, SLUG, status],
  );
  return id;
}

/** Every campaign row of this store, however it ended up. */
async function campaignRows(): Promise<{ status: string; archived_at: Date | string | null }[]> {
  const { rows } = await query<{ status: string; archived_at: Date | string | null }>(
    'SELECT status, archived_at FROM ad_campaigns WHERE store_id = $1', [STORE_ID]);
  return rows;
}

/** The store as it stands right now — re-read, never a cached object. */
const current = async () => (await getStoreById(STORE_ID))!;

/** How many store rows carry this id — the "nothing is deleted" assertion. */
async function storeRowCount(): Promise<number> {
  const { rows } = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM stores WHERE id = $1', [STORE_ID]);
  return rows[0]!.n;
}

/**
 * Write these orders as the only orders in the database.
 *
 * One row per order plus one `order_stores` row per store the order names — which is what
 * `countOrdersByStoreSlug` reads, so an order written without its slice would be invisible to the
 * very count under test.
 */
async function writeOrders(orders: Order[]): Promise<void> {
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM orders');
  for (const o of orders) {
    await query(
      `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status, created_at)
       VALUES ($1, 'A', 'a@b.c', $2, $3, $4, $5)`,
      [o.id, o.totalAgorot, o.paymentStatus, o.shippingStatus, o.createdAt],
    );
    for (const slug of new Set(o.items.map((i) => i.storeSlug))) {
      await query(
        `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot)
         VALUES ($1, $2, 'S', $3, 0)`,
        [o.id, slug, o.totalAgorot],
      );
    }
  }
}

beforeEach(async () => {
  await query('DELETE FROM ad_campaigns WHERE store_id = $1', [STORE_ID]);
  await writeOrders([]);
  await query('DELETE FROM stores WHERE id = $1', [STORE_ID]);
  await query(
    `INSERT INTO stores (id, seller_id, slug, name, tagline, description, colors, created_at)
     VALUES ($1, $2, $3, 'My Store', '', '', '{"primary":"#000","accent":"#111"}'::jsonb, '2026-01-01T00:00:00.000Z')`,
    [STORE_ID, SELLER_ID, SLUG],
  );
});

describe('pause and resume', () => {
  it('stops selling immediately, and reopening puts it straight back', async () => {
    expect((await pauseStore(STORE_ID)).ok).toBe(true);
    expect(storeLifecycle(await current())).toBe('paused');
    expect((await resumeStore(STORE_ID)).ok).toBe(true);
    expect(storeLifecycle(await current())).toBe('active');
  });

  // A second dashboard tab must not be able to move the moment the pause began — pausedAt is
  // what a future "paused since" reading would rest on.
  it('is idempotent: pausing twice keeps the first timestamp', async () => {
    await pauseStore(STORE_ID);
    const first = (await current()).pausedAt;
    await pauseStore(STORE_ID);
    expect((await current()).pausedAt).toBe(first);
  });

  it('never lets a seller pause-and-reopen out of an admin block', async () => {
    await updateStore(STORE_ID, { blocked: true });
    expect((await pauseStore(STORE_ID)).ok).toBe(false);
    expect((await resumeStore(STORE_ID)).ok).toBe(false);
    expect(storeLifecycle(await current())).toBe('blocked');
  });

  it('refuses any transition once the store is closed', async () => {
    await updateStore(STORE_ID, { closedAt: '2026-07-20T00:00:00.000Z' });
    expect((await pauseStore(STORE_ID)).ok).toBe(false);
    expect((await resumeStore(STORE_ID)).ok).toBe(false);
  });
});

// "Open orders" is now a number three surfaces show — the seller's settings screen, the admin's
// store list, and the email that tells a seller what they still owe. Two implementations feed
// them (one re-reads the file per store, one groups orders the admin already loaded), so this is
// the invariant that stops them from ever answering differently.
describe('the two open-order counters agree', () => {
  it('gives the same number per store, whichever way it is asked', async () => {
    const orders = [
      order('o1'),
      order('o2', { shippingStatus: 'shipped' }),
      order('o3', { shippingStatus: 'delivered' }),
      order('o4', { paymentStatus: 'failed' }),
      order('o5', { shippingStatus: 'cancelled' }),
      // Another store's order must not land in this store's count.
      order('o6', { items: [{ productId: 'p9', productName: 'X', storeSlug: 'other-store', storeName: 'Other', priceAgorot: 5, qty: 1, image: '' }] } as Partial<Order>),
    ];
    await writeOrders(orders);
    // One is a COUNT query, the other groups orders the admin already loaded. They must not drift.
    const map = countOpenOrdersByStore(orders);
    expect(map.get(SLUG) ?? 0).toBe(await openOrderCount(SLUG));
    expect(map.get(SLUG)).toBe(2);
    expect(map.get('other-store')).toBe(1);
  });

  // One order naming the same store twice (two lines from one shop) is ONE obligation, not two —
  // otherwise the admin's "waiting on 4 orders" would outrun the seller's list of 2.
  it('counts an order once however many of its lines belong to the store', async () => {
    const orders = [order('o1', {
      items: [
        { productId: 'p1', productName: 'A', storeSlug: SLUG, storeName: 'My Store', priceAgorot: 10, qty: 1, image: '' },
        { productId: 'p2', productName: 'B', storeSlug: SLUG, storeName: 'My Store', priceAgorot: 20, qty: 1, image: '' },
      ],
    } as Partial<Order>)];
    await writeOrders(orders);
    expect(countOpenOrdersByStore(orders).get(SLUG)).toBe(1);
    expect(await openOrderCount(SLUG)).toBe(1);
  });
});

describe('closing with nothing owed', () => {
  it('closes on the spot', async () => {
    const res = await requestStoreClosure(STORE_ID);
    expect(res.ok && res.state).toBe('closed');
    expect((await current()).closedAt).toBeTruthy();
  });

  it('keeps the store record — closing is a flag, never a delete', async () => {
    await requestStoreClosure(STORE_ID);
    expect(await storeRowCount()).toBe(1);
    expect((await current()).slug).toBe(SLUG);
  });

  it('archives running boost campaigns instead of deleting them, so past spend survives', async () => {
    await seedCampaign('active');
    await seedCampaign('paused');
    await requestStoreClosure(STORE_ID);
    // One statement archives them all now, rather than one write per campaign — but what this
    // pins is the outcome: both rows still exist, both stopped, and neither was erased.
    const rows = await campaignRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((c) => c.archived_at)).toBe(true);
    expect(rows.every((c) => c.status === 'paused')).toBe(true);
  });
});

describe('closing while orders are still open', () => {
  beforeEach(async () => { await writeOrders([order('o1'), order('o2', { shippingStatus: 'shipped' })]); });

  it('counts only orders that still owe the buyer something', async () => {
    await writeOrders([
      order('o1'),                                        // paid, pending  → open
      order('o2', { shippingStatus: 'delivered' }),       // done
      order('o3', { shippingStatus: 'cancelled' }),       // done
      order('o4', { paymentStatus: 'failed' }),           // nobody paid
    ]);
    expect(await openOrderCount(SLUG)).toBe(1);
  });

  // The heart of it: the seller wants no more sales, but two parcels are still out. The store
  // stops selling now, and the closure waits — rather than being refused.
  it('stops selling at once and leaves the closure pending', async () => {
    const res = await requestStoreClosure(STORE_ID);
    expect(res.ok && res.state).toBe('closing');
    expect(res.ok && res.openOrders).toBe(2);
    expect((await current()).closedAt).toBeUndefined();
    expect((await current()).pausedAt).toBeTruthy();
  });

  it('completes the closure by itself when the last open order is done', async () => {
    await requestStoreClosure(STORE_ID);
    await writeOrders([order('o1', { shippingStatus: 'delivered' }), order('o2', { shippingStatus: 'shipped' })]);
    expect(await settleStoreClosure(SLUG)).toBeNull();          // one still in transit
    expect(storeLifecycle(await current())).toBe('closing');

    await writeOrders([order('o1', { shippingStatus: 'delivered' }), order('o2', { shippingStatus: 'delivered' })]);
    expect(await settleStoreClosure(SLUG)).not.toBeNull();
    expect(storeLifecycle(await current())).toBe('closed');
  });

  it('lets the seller call the closure off, which reopens the store', async () => {
    await requestStoreClosure(STORE_ID);
    expect((await resumeStore(STORE_ID)).ok).toBe(true);
    expect(storeLifecycle(await current())).toBe('active');
    // And a later settle must not resurrect the cancelled intent.
    await writeOrders([]);
    expect(await settleStoreClosure(SLUG)).toBeNull();
    expect(storeLifecycle(await current())).toBe('active');
  });

  it('does nothing for a store with no closure pending', async () => {
    await writeOrders([]);
    expect(await settleStoreClosure(SLUG)).toBeNull();
    await pauseStore(STORE_ID);
    expect(await settleStoreClosure(SLUG)).toBeNull();
    expect(storeLifecycle(await current())).toBe('paused');
  });
});
