import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { getFavoriteStoresForUser, getRecentStoresForUser, getUserCart } from '../src/lib/user-carts.js';

/**
 * `/api/user-cart` and `/api/favorite-store`, against a real Postgres and the real module beneath.
 *
 * Only the SESSION is stubbed, because everything this file exists to hold is decided at the route:
 * whose state a request may read or write, which fields a sync is allowed to move, and what a
 * request that lies about its shape may store. A mocked `user-carts.js` would have tested the mock —
 * the mistake `checkout.test.ts` made for both of them.
 *
 * The third endpoint that used to sit here, `/api/wishlist`, is gone. It took `{action, productSlug}`
 * with **no store and no session**: it could not name a product uniquely (§7.1 — 47 slugs repeat
 * across stores) and could not say whose wishlist it was, so anyone at all could move a number the
 * seller reads on their dashboard. The wishlist already syncs through the authenticated endpoint
 * below, and the count is now `COUNT(*)` over the rows that sync writes.
 */

const BUYER = 'buyer-account-1';
const OTHER = 'buyer-account-2';

let session: string | null = BUYER;

vi.mock('../src/lib/seller-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/seller-auth.js')>()),
  getSellerSession: () => session,
}));

const cart = await import('../src/pages/api/user-cart.js');
const favorite = await import('../src/pages/api/favorite-store.js');

const cookies = {} as never;

function postCart(body: unknown, init: RequestInit = {}) {
  return cart.POST({
    request: new Request('https://x.test/api/user-cart', { method: 'POST', body: JSON.stringify(body), ...init }),
    cookies,
  } as never) as Promise<Response>;
}

function postFavorite(body: unknown) {
  return favorite.POST({
    request: new Request('https://x.test/api/favorite-store', { method: 'POST', body: JSON.stringify(body) }),
    cookies,
  } as never) as Promise<Response>;
}

let storeSlug: string;
let storeId: string;

beforeEach(async () => {
  session = BUYER;
  await query('DELETE FROM cart_items');
  await query('DELETE FROM wishlist_items');
  await query('DELETE FROM favorite_stores');
  await query('DELETE FROM recent_stores');

  const sellerId = crypto.randomUUID();
  storeId = crypto.randomUUID();
  storeSlug = `api-uc-${crypto.randomBytes(4).toString('hex')}`;
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'חנות')`,
    [storeId, sellerId, storeSlug]);
  await query(
    `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock)
     VALUES ($1, $2, 'widget', 'מוצר', 5000, 4)`,
    [crypto.randomUUID(), storeId],
  );
});

function snapshot(over: Record<string, unknown> = {}) {
  return {
    cart: {
      [storeSlug]: {
        storeName: 'חנות',
        storeSlug,
        items: {
          widget: { cartKey: 'widget', slug: 'widget', name: 'מוצר', price: 50, image: 'a.png', qty: 2 },
        },
      },
    },
    wishlist: [{ slug: 'widget', name: 'מוצר', price: 50, image: 'a.png', storeSlug, storeName: 'חנות' }],
    ...over,
  };
}

describe('/api/user-cart', () => {
  it('refuses to read or write without a session', async () => {
    session = null;
    expect((await cart.GET({ cookies } as never) as Response).status).toBe(401);
    expect((await postCart(snapshot())).status).toBe(401);
  });

  it('round-trips a snapshot through the database', async () => {
    expect((await postCart(snapshot())).status).toBe(200);
    const body = await (await cart.GET({ cookies } as never) as Response).json() as Awaited<ReturnType<typeof getUserCart>>;
    expect(body.cart[storeSlug]!.items['widget']!.qty).toBe(2);
    expect(body.wishlist.map((w) => w.slug)).toEqual(['widget']);
  });

  it('reads only the signed-in account, never another', async () => {
    await postCart(snapshot());
    session = OTHER;
    const body = await (await cart.GET({ cookies } as never) as Response).json() as { cart: Record<string, unknown> };
    expect(body.cart).toEqual({});
  });

  it('rejects a body whose cart or wishlist is not the declared shape', async () => {
    expect((await postCart({ cart: 'everything', wishlist: [] })).status).toBe(400);
    expect((await postCart({ cart: {}, wishlist: 'nothing' })).status).toBe(400);
    expect((await postCart({ cart: {}, wishlist: [], recentStores: [1, 2] })).status).toBe(400);
  });

  it('does not erase the saved stores it no longer carries', async () => {
    await postFavorite({ storeSlug });
    await postCart(snapshot());
    // The file version had to read the saved stores and hand them back on every cart sync purely to
    // avoid deleting them; here they are a different table and this route never names it.
    expect(await getFavoriteStoresForUser(BUYER)).toEqual([storeSlug]);
  });

  it('unions the recent list with what other devices recorded, and leaves it alone when absent', async () => {
    await postCart(snapshot({ recentStores: ['a', 'b'] }));
    await postCart(snapshot({ recentStores: ['c', 'a'] }));
    expect(await getRecentStoresForUser(BUYER)).toEqual(['c', 'a', 'b']);

    await postCart(snapshot());
    // A device with no cookie says nothing about the account's history — it must not empty it.
    expect(await getRecentStoresForUser(BUYER)).toEqual(['c', 'a', 'b']);
  });

  it('refuses a body larger than the cap even when the request does not declare its length', async () => {
    const huge = { cart: {}, wishlist: [], filler: 'x'.repeat(600_000) };
    // Chunked: no Content-Length to check, which is exactly how the header-only guard was passed.
    const res = await postCart(huge, {});
    expect(res.status).toBe(413);
  });
});

describe('/api/favorite-store', () => {
  it('refuses without a session', async () => {
    session = null;
    expect((await postFavorite({ storeSlug })).status).toBe(401);
  });

  it('toggles on, then off, and reports the count each time', async () => {
    const on = await (await postFavorite({ storeSlug })).json() as { favorited: boolean; count: number };
    expect(on).toEqual({ favorited: true, count: 1 });
    const off = await (await postFavorite({ storeSlug })).json() as { favorited: boolean; count: number };
    expect(off).toEqual({ favorited: false, count: 0 });
  });

  it('counts other people too', async () => {
    await postFavorite({ storeSlug });
    session = OTHER;
    const res = await (await postFavorite({ storeSlug })).json() as { count: number };
    expect(res.count).toBe(2);
  });

  it('rejects a missing or non-string slug, and an unknown store', async () => {
    expect((await postFavorite({})).status).toBe(400);
    expect((await postFavorite({ storeSlug: 42 })).status).toBe(400);
    expect((await postFavorite(null)).status).toBe(400);
    expect((await postFavorite({ storeSlug: 'no-such-store' })).status).toBe(404);
  });

  it('stores the CURRENT store even when the request names a previous slug', async () => {
    const oldSlug = storeSlug;
    const newSlug = `${storeSlug}-renamed`;
    await query('UPDATE stores SET slug = $2 WHERE id = $1', [storeId, newSlug]);
    await query('INSERT INTO store_previous_slugs (slug, store_id) VALUES ($1, $2)', [oldSlug, storeId]);

    const res = await (await postFavorite({ storeSlug: oldSlug })).json() as { favorited: boolean; count: number };
    expect(res).toEqual({ favorited: true, count: 1 });
    // Saved stores key by id, so a page that loaded before the rename still toggles the right row —
    // and the count answers for the store, not for the name the request happened to use.
    expect(await getFavoriteStoresForUser(BUYER)).toEqual([newSlug]);
  });
});
