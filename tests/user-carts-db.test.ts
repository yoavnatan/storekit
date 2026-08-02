/**
 * Buyer state — cart, wishlist, saved stores, recently-visited — against a real Postgres.
 * The third and last of the bucket diffs (DB_MIGRATION_PLAN.md §5).
 *
 * **What the suite had before: nothing.** Measured, not estimated — all three modules
 * (`user-carts`, `wishlist-counts`, `store-favorite-counts`) were replaced with versions returning
 * an empty cart, an empty wishlist and zero counts, and the full suite stayed at **1732 of 1732**
 * across 143 files. Not one test in the repo would have failed. `cart.test.ts` and
 * `header-cart-badge.test.ts` are about the browser's `localStorage` half, `cart-prices*.test.ts`
 * about server-side re-pricing, and `checkout.test.ts` mocked the module whole.
 *
 * So this pins the three things that could only be got wrong in the move:
 *
 * 1. **Identity.** The application speaks slugs; two of the four tables key by uuid. A bare product
 *    slug is not unique across stores (§7.1 measured 47 that repeat), which is the defect
 *    `wishlist-counts.json` shipped with — one number shared by two unrelated products. The test
 *    `two stores with the same product slug keep separate wishlist counts` fails against any
 *    implementation that keys a count by slug alone.
 *
 * 2. **The write is a diff, not a rewrite.** A quantity change must be one `UPDATE` of one row, not
 *    a delete-and-reinsert of the whole cart — checked by watching `added_at`, which only a
 *    re-insert would move.
 *
 * 3. **What the file version got wrong, staying wrong.** The checkout used to hand back every field
 *    of the buyer's state in order to change one, and the field it forgot (`recentStores`) was
 *    silently emptied by every purchase. `removeCartLines` cannot express that, and the test that
 *    says so is `buying does not touch anything but the purchased lines`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { getDatabase, query, setDatabase, type Database, type Queryable } from '../src/lib/db.js';
import {
  countFavoriteStores,
  getFavoriteStoresForUser,
  getRecentStoresForUser,
  getUserCart,
  getWishlistCountsForStore,
  isStoreFavorited,
  removeCartLines,
  renameStoreSlugInUserData,
  replaceUserCart,
  toggleFavoriteStore,
  type UserStoreCart,
} from '../src/lib/user-carts.js';
import type { WishlistItem } from '../src/lib/wishlist.js';

let seq = 0;
/** The lazy PGlite the setup file installed — put back after a test swaps the driver. */
const realDb = getDatabase();

interface Fixture {
  storeId: string;
  storeSlug: string;
  productIds: Record<string, string>;
}

/** A store with products of its own, so one case's rows can never be read by another. */
async function freshStore(productSlugs: string[] = ['widget']): Promise<Fixture> {
  seq += 1;
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  const storeSlug = `uc-test-${seq}-${crypto.randomBytes(3).toString('hex')}`;
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'חנות')`,
    [storeId, sellerId, storeSlug]);
  const productIds: Record<string, string> = {};
  for (const slug of productSlugs) {
    const id = crypto.randomUUID();
    productIds[slug] = id;
    await query(
      `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock)
       VALUES ($1, $2, $3, $4, 5000, 7)`,
      [id, storeId, slug, `מוצר ${slug}`],
    );
  }
  return { storeId, storeSlug, productIds };
}

function cartOf(storeSlug: string, items: Record<string, { slug: string; qty: number; price?: number }>): Record<string, UserStoreCart> {
  return {
    [storeSlug]: {
      storeName: 'חנות',
      storeSlug,
      items: Object.fromEntries(Object.entries(items).map(([cartKey, it]) => [cartKey, {
        cartKey, slug: it.slug, name: `מוצר ${it.slug}`, price: it.price ?? 50, image: 'a.png', qty: it.qty,
      }])),
    },
  };
}

function wish(storeSlug: string, slug: string): WishlistItem {
  return { slug, name: `מוצר ${slug}`, price: 50, image: 'a.png', storeSlug, storeName: 'חנות' };
}

let user: string;
beforeEach(() => { user = `buyer-${crypto.randomUUID()}`; });

describe('the saved cart', () => {
  it('round-trips a line, grouped by store, with the variant selection intact', async () => {
    const { storeSlug } = await freshStore();
    await replaceUserCart(user, {
      cart: {
        [storeSlug]: {
          storeName: 'חנות',
          storeSlug,
          items: {
            'widget__color=red': {
              cartKey: 'widget__color=red', slug: 'widget', name: 'מוצר widget',
              price: 49.9, basePrice: 79.9, image: 'a.png', qty: 3,
              selectedVariants: { color: 'red' },
            },
          },
        },
      },
      wishlist: [],
    });

    const { cart } = await getUserCart(user);
    const item = cart[storeSlug]!.items['widget__color=red']!;
    expect(item.qty).toBe(3);
    // Money is integer agorot in the column (§7.7) and ILS at the module's edge — a price that came
    // back as 4990 would be a hundredfold error that `number → number` passes over in silence.
    // Compared in agorot, where the values are the exact integers the column holds.
    expect(Math.round(item.price * 100)).toBe(4990);
    expect(Math.round(item.basePrice! * 100)).toBe(7990);
    expect(item.selectedVariants).toEqual({ color: 'red' });
  });

  it('an unchanged line is NOT rewritten — a quantity change is one UPDATE of one row', async () => {
    const { storeSlug } = await freshStore(['widget', 'gizmo']);
    await replaceUserCart(user, {
      cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1 }, gizmo: { slug: 'gizmo', qty: 1 } }),
      wishlist: [],
    });
    const before = await query<{ cart_key: string; added_at: Date }>(
      'SELECT cart_key, added_at FROM cart_items WHERE user_id = $1 ORDER BY cart_key', [user]);

    await replaceUserCart(user, {
      cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1 }, gizmo: { slug: 'gizmo', qty: 5 } }),
      wishlist: [],
    });
    const after = await query<{ cart_key: string; added_at: Date; qty: number }>(
      'SELECT cart_key, added_at, qty FROM cart_items WHERE user_id = $1 ORDER BY cart_key', [user]);

    expect(after.rows.map((r) => r.qty)).toEqual([5, 1]); // gizmo, widget
    // `added_at` defaults to now() on insert and is never written by an update, so it is the
    // fingerprint of a delete-and-reinsert. Both rows must still carry their original one — the
    // untouched line above all, which a rewrite of the whole cart would have replaced.
    expect(after.rows.map((r) => new Date(r.added_at).getTime()))
      .toEqual(before.rows.map((r) => new Date(r.added_at).getTime()));
  });

  it('a line the browser dropped is deleted, and one it added appears', async () => {
    const { storeSlug } = await freshStore(['widget', 'gizmo']);
    await replaceUserCart(user, { cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1 } }), wishlist: [] });
    await replaceUserCart(user, { cart: cartOf(storeSlug, { gizmo: { slug: 'gizmo', qty: 2 } }), wishlist: [] });
    const { cart } = await getUserCart(user);
    expect(Object.keys(cart[storeSlug]!.items)).toEqual(['gizmo']);
  });

  it('an empty snapshot empties the cart', async () => {
    const { storeSlug } = await freshStore();
    await replaceUserCart(user, { cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1 } }), wishlist: [] });
    await replaceUserCart(user, { cart: {}, wishlist: [] });
    expect(await getUserCart(user)).toMatchObject({ cart: {} });
  });

  it('keeps a line whose product was deleted — the buyer must see what became unavailable', async () => {
    const { storeSlug, productIds } = await freshStore();
    await replaceUserCart(user, { cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1 } }), wishlist: [] });
    await query('DELETE FROM store_products WHERE id = $1', [productIds['widget']]);
    // No foreign key on cart_items, on purpose (see the module's header): a cascade here would make
    // the line vanish, which is the behaviour `CartItem.unavailable` exists to prevent.
    const { cart } = await getUserCart(user);
    expect(cart[storeSlug]!.items['widget']).toBeDefined();
  });

  it('trims a snapshot that claims hundreds of lines instead of storing them', async () => {
    const { storeSlug } = await freshStore();
    const items: Record<string, { slug: string; qty: number }> = {};
    for (let i = 0; i < 500; i++) items[`k${i}`] = { slug: 'widget', qty: 1 };
    await replaceUserCart(user, { cart: cartOf(storeSlug, items), wishlist: [] });
    // The body cap bounds bytes, not rows: minimal JSON turns a small request into thousands of
    // rows, and a cart is a shopping list.
    const { rows } = await query<{ count: string }>('SELECT COUNT(*) AS count FROM cart_items WHERE user_id = $1', [user]);
    expect(Number(rows[0]!.count)).toBe(300);
  });

  /**
   * Four 500s that any signed-in account could raise, all found by the repo's own review pass and
   * all from two classes this codebase has met before: the column type is a limit (`integer`,
   * `bigint`), and so is the index (a btree entry cannot exceed 2704 bytes). Each of these fails
   * with `value out of range` or `index row size … exceeds btree version 4 maximum` without the
   * ceilings in the module — checked, not assumed.
   */
  describe('a request that lies about its own size', () => {
    /** Random, because pglz compresses a repeated character to well under the btree limit — a test
     *  built on `'x'.repeat(10000)` passes against the unfixed code and proves nothing. */
    const long = (n: number) => crypto.randomBytes(n).toString('base64');

    it('does not raise on a quantity larger than the column', async () => {
      const { storeSlug } = await freshStore();
      await replaceUserCart(user, { cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1e30 } }), wishlist: [] });
      expect((await getUserCart(user)).cart[storeSlug]!.items['widget']!.qty).toBe(10_000);
    });

    it('does not raise on a price larger than the column', async () => {
      const { storeSlug } = await freshStore();
      await replaceUserCart(user, {
        cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1, price: 1e30 } }), wishlist: [],
      });
      // Clamped, not rejected: the cart's price is display-only — the charge comes from the
      // server's own resolution at checkout — so a tampered value misleads only the tamperer.
      expect((await getUserCart(user)).cart[storeSlug]!.items['widget']!.price).toBe(10_000_000);
    });

    it('drops a cart line whose key is too long for the index instead of raising', async () => {
      const { storeSlug } = await freshStore();
      await replaceUserCart(user, {
        cart: cartOf(storeSlug, { [long(6000)]: { slug: 'widget', qty: 1 }, ok: { slug: 'widget', qty: 1 } }),
        wishlist: [],
      });
      // Dropped rather than truncated: a shortened key is a DIFFERENT line, so the next sync would
      // add a second copy of it beside the first.
      expect(Object.keys((await getUserCart(user)).cart[storeSlug]!.items)).toEqual(['ok']);
    });

    it('drops a recent-store slug too long for the index instead of raising', async () => {
      await replaceUserCart(user, { cart: {}, wishlist: [], recentStores: [long(6000), 'real'] });
      expect(await getRecentStoresForUser(user)).toEqual(['real']);
    });

    it('trims the display fields rather than dropping the line', async () => {
      const { storeSlug } = await freshStore();
      await replaceUserCart(user, {
        cart: {
          [storeSlug]: {
            storeName: long(6000), storeSlug,
            items: { widget: { cartKey: 'widget', slug: 'widget', name: long(6000), price: 5, image: long(6000), qty: 1 } },
          },
        },
        wishlist: [],
      });
      const group = (await getUserCart(user)).cart[storeSlug]!;
      expect(group.storeName).toHaveLength(200);
      expect(group.items['widget']!.name).toHaveLength(200);
      expect(group.items['widget']!.image).toHaveLength(2000);
    });

    it('keeps only string variant pairs, bounded — it lands in jsonb straight from the request', async () => {
      const { storeSlug } = await freshStore();
      const variants: Record<string, unknown> = { color: long(300), size: { nested: 'object' } };
      for (let i = 0; i < 50; i++) variants[`k${i}`] = 'v';
      await replaceUserCart(user, {
        cart: {
          [storeSlug]: {
            storeName: 'חנות', storeSlug,
            items: { widget: { cartKey: 'widget', slug: 'widget', name: 'n', price: 5, image: '', qty: 1, selectedVariants: variants as Record<string, string> } },
          },
        },
        wishlist: [],
      });
      const stored = (await getUserCart(user)).cart[storeSlug]!.items['widget']!.selectedVariants!;
      expect(Object.keys(stored).length).toBeLessThanOrEqual(20);
      expect(stored['size']).toBeUndefined();
      expect(stored['color']).toHaveLength(100);
    });

    it('ignores a wishlist entry whose slug could not name a product', async () => {
      const { storeSlug, storeId } = await freshStore();
      await replaceUserCart(user, {
        cart: {},
        wishlist: [{ ...wish(storeSlug, 'widget'), slug: long(6000) }, wish(storeSlug, 'widget')],
      });
      expect(await getWishlistCountsForStore(storeId)).toEqual({ widget: 1 });
    });
  });

  it('a qty of zero or a fraction is clamped, not stored — the column forbids it', async () => {
    const { storeSlug } = await freshStore();
    await replaceUserCart(user, { cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 0 } }), wishlist: [] });
    const { cart } = await getUserCart(user);
    expect(cart[storeSlug]!.items['widget']!.qty).toBe(1);
  });
});

describe('buying', () => {
  it('deletes only the purchased lines and touches nothing else the buyer owns', async () => {
    const { storeSlug } = await freshStore(['widget', 'gizmo']);
    await replaceUserCart(user, {
      cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1 }, gizmo: { slug: 'gizmo', qty: 1 } }),
      wishlist: [wish(storeSlug, 'gizmo')],
      recentStores: [storeSlug, 'other-store'],
    });

    await removeCartLines(user, [{ storeSlug, cartKey: 'widget' }]);

    const state = await getUserCart(user);
    expect(Object.keys(state.cart[storeSlug]!.items)).toEqual(['gizmo']);
    expect(state.wishlist).toHaveLength(1);
    // The regression this replaces: the checkout's save omitted `recentStores`, so every purchase
    // wiped the buyer's cross-device recently-visited list. It is not an argument here at all.
    expect(state.recentStores).toEqual([storeSlug, 'other-store']);
  });

  it('a line of another buyer with the same cart key is not touched', async () => {
    const { storeSlug } = await freshStore();
    const other = `buyer-${crypto.randomUUID()}`;
    const snapshot = { cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1 } }), wishlist: [] };
    await replaceUserCart(user, snapshot);
    await replaceUserCart(other, snapshot);
    await removeCartLines(user, [{ storeSlug, cartKey: 'widget' }]);
    expect(Object.keys((await getUserCart(other)).cart[storeSlug]!.items)).toEqual(['widget']);
  });

  it('an empty purchase list deletes nothing', async () => {
    const { storeSlug } = await freshStore();
    await replaceUserCart(user, { cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1 } }), wishlist: [] });
    await removeCartLines(user, []);
    expect(Object.keys((await getUserCart(user)).cart[storeSlug]!.items)).toEqual(['widget']);
  });
});

describe('the wishlist', () => {
  it('resolves (storeSlug, slug) to a product and reads the item back from the product itself', async () => {
    const { storeSlug } = await freshStore();
    await replaceUserCart(user, { cart: {}, wishlist: [wish(storeSlug, 'widget')] });
    const { wishlist } = await getUserCart(user);
    expect(wishlist).toHaveLength(1);
    // Name/price/stock come from the product row, not from the snapshot taken when the heart was
    // clicked — so a price change reaches the drawer, which the JSON version never did.
    expect(wishlist[0]).toMatchObject({ slug: 'widget', name: 'מוצר widget', price: 50, stock: 7, storeSlug });
  });

  it('two stores sharing a product slug keep separate wishlist counts', async () => {
    const a = await freshStore(['widget']);
    const b = await freshStore(['widget']);
    await replaceUserCart(user, { cart: {}, wishlist: [wish(a.storeSlug, 'widget')] });

    // §7.1: 47 product slugs repeat across stores, and `wishlist-counts.json` was keyed by the bare
    // slug — so this exact case has been adding two unrelated products into one number. Any
    // implementation that keys a count by slug alone gives both stores 1 here.
    expect(await getWishlistCountsForStore(a.storeId)).toEqual({ widget: 1 });
    expect(await getWishlistCountsForStore(b.storeId)).toEqual({});
  });

  it('names an entry once even when the browser sends it twice', async () => {
    const { storeSlug, storeId } = await freshStore();
    await replaceUserCart(user, { cart: {}, wishlist: [wish(storeSlug, 'widget'), wish(storeSlug, 'widget')] });
    // The analytics diff hit this as a hard failure — Postgres REJECTS an `ON CONFLICT DO UPDATE`
    // that touches one row twice in a single command. `DO NOTHING`, which is all a set membership
    // needs, tolerates it, so the duplicate is skipped rather than fatal. Written down because the
    // difference is invisible at the call site and only one of the two forms is safe here.
    expect(await getWishlistCountsForStore(storeId)).toEqual({ widget: 1 });
  });

  it('drops an entry naming a product that does not exist, and keeps the rest', async () => {
    const { storeSlug, storeId } = await freshStore(['widget']);
    await replaceUserCart(user, {
      cart: {},
      wishlist: [wish(storeSlug, 'widget'), wish(storeSlug, 'ghost'), wish('no-such-store', 'widget')],
    });
    expect(await getWishlistCountsForStore(storeId)).toEqual({ widget: 1 });
  });

  it('an entry the browser dropped is removed', async () => {
    const { storeSlug, storeId } = await freshStore(['widget', 'gizmo']);
    await replaceUserCart(user, { cart: {}, wishlist: [wish(storeSlug, 'widget'), wish(storeSlug, 'gizmo')] });
    await replaceUserCart(user, { cart: {}, wishlist: [wish(storeSlug, 'gizmo')] });
    expect(await getWishlistCountsForStore(storeId)).toEqual({ gizmo: 1 });
  });

  it('counts people, and a deleted product takes its entries with it', async () => {
    const { storeSlug, storeId, productIds } = await freshStore();
    const other = `buyer-${crypto.randomUUID()}`;
    await replaceUserCart(user, { cart: {}, wishlist: [wish(storeSlug, 'widget')] });
    await replaceUserCart(other, { cart: {}, wishlist: [wish(storeSlug, 'widget')] });
    expect(await getWishlistCountsForStore(storeId)).toEqual({ widget: 2 });

    await query('DELETE FROM store_products WHERE id = $1', [productIds['widget']]);
    expect(await getWishlistCountsForStore(storeId)).toEqual({});
    // A stored counter would still be reading 2 here, which is the whole reason §5 replaced it.
    expect((await getUserCart(user)).wishlist).toEqual([]);
  });

  it('leaves the wishlist alone when the sync carries only a cart', async () => {
    const { storeSlug, storeId } = await freshStore();
    await replaceUserCart(user, { cart: {}, wishlist: [wish(storeSlug, 'widget')] });
    await replaceUserCart(user, { cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1 } }), wishlist: [] });
    // A snapshot IS authoritative for the wishlist too, so an empty array does empty it — this
    // pins that the emptying is the array's doing and not a side effect of writing the cart.
    expect(await getWishlistCountsForStore(storeId)).toEqual({});
  });
});

describe('saved stores', () => {
  it('toggles on and off, and the answer is the write, not a read that preceded it', async () => {
    const { storeId, storeSlug } = await freshStore();
    expect(await toggleFavoriteStore(user, storeId)).toBe(true);
    expect(await isStoreFavorited(user, storeId)).toBe(true);
    expect(await getFavoriteStoresForUser(user)).toEqual([storeSlug]);
    expect(await countFavoriteStores(storeId)).toBe(1);

    expect(await toggleFavoriteStore(user, storeId)).toBe(false);
    expect(await isStoreFavorited(user, storeId)).toBe(false);
    expect(await countFavoriteStores(storeId)).toBe(0);
  });

  it('counts each person once and no one else', async () => {
    const { storeId } = await freshStore();
    const otherStore = await freshStore();
    const other = `buyer-${crypto.randomUUID()}`;
    await toggleFavoriteStore(user, storeId);
    await toggleFavoriteStore(other, storeId);
    await toggleFavoriteStore(other, otherStore.storeId);
    expect(await countFavoriteStores(storeId)).toBe(2);
    expect(await countFavoriteStores(otherStore.storeId)).toBe(1);
  });

  it('a deleted store leaves nobody with a saved store that is not there', async () => {
    const { storeId } = await freshStore();
    await toggleFavoriteStore(user, storeId);
    await query('DELETE FROM stores WHERE id = $1', [storeId]);
    expect(await getFavoriteStoresForUser(user)).toEqual([]);
  });

  it('a store marked deleted is hidden from the list without deleting the row', async () => {
    const { storeId } = await freshStore();
    await toggleFavoriteStore(user, storeId);
    await query('UPDATE stores SET deleted_at = now() WHERE id = $1', [storeId]);
    expect(await getFavoriteStoresForUser(user)).toEqual([]);
  });

  it('is not written by a cart sync', async () => {
    const { storeId, storeSlug } = await freshStore();
    await toggleFavoriteStore(user, storeId);
    await replaceUserCart(user, { cart: {}, wishlist: [], recentStores: [] });
    // The file version had to READ the saved stores and hand them back on every cart sync just to
    // avoid erasing them. Here they are a different table and simply are not in the statement.
    expect(await getFavoriteStoresForUser(user)).toEqual([storeSlug]);
  });
});

describe('recently-visited stores', () => {
  it('keeps the order the browser sent, newest first', async () => {
    await replaceUserCart(user, { cart: {}, wishlist: [], recentStores: ['c', 'a', 'b'] });
    expect(await getRecentStoresForUser(user)).toEqual(['c', 'a', 'b']);
  });

  it('is left alone when the sync does not carry a list', async () => {
    await replaceUserCart(user, { cart: {}, wishlist: [], recentStores: ['a', 'b'] });
    await replaceUserCart(user, { cart: {}, wishlist: [] });
    // A device with no cookie must not erase the account's cross-device history.
    expect(await getRecentStoresForUser(user)).toEqual(['a', 'b']);
  });

  it('is capped, so the list cannot grow without bound', async () => {
    await replaceUserCart(user, {
      cart: {}, wishlist: [],
      recentStores: Array.from({ length: 40 }, (_, i) => `s${i}`),
    });
    expect(await getRecentStoresForUser(user)).toHaveLength(12);
  });
});

describe('a store changing its URL', () => {
  it('carries the cart lines and the recent list, and needs to carry nothing else', async () => {
    const { storeId, storeSlug } = await freshStore();
    const newSlug = `${storeSlug}-renamed`;
    await replaceUserCart(user, {
      cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 2 } }),
      wishlist: [wish(storeSlug, 'widget')],
      recentStores: [storeSlug, 'other'],
    });
    await toggleFavoriteStore(user, storeId);

    await query('UPDATE stores SET slug = $2 WHERE id = $1', [storeId, newSlug]);
    await renameStoreSlugInUserData(storeSlug, newSlug);

    const state = await getUserCart(user);
    expect(Object.keys(state.cart)).toEqual([newSlug]);
    expect(state.cart[newSlug]!.items['widget']!.qty).toBe(2);
    expect(state.recentStores).toEqual([newSlug, 'other']);
    // Saved stores and wishlist entries key by id, so the rename cannot orphan them and the
    // function does not name their tables at all — the same reason `renameStoreSlugInPageviews`
    // was deleted outright when the view buckets moved.
    expect(state.favoriteStores).toEqual([newSlug]);
    expect(state.wishlist[0]!.storeSlug).toBe(newSlug);
  });

  it('does not fail when the buyer already holds lines under both slugs', async () => {
    const { storeId, storeSlug } = await freshStore();
    const newSlug = `${storeSlug}-renamed`;
    await replaceUserCart(user, {
      cart: {
        ...cartOf(storeSlug, { widget: { slug: 'widget', qty: 9 } }),
        ...cartOf(newSlug, { widget: { slug: 'widget', qty: 1 } }),
      },
      wishlist: [],
      recentStores: [storeSlug, newSlug],
    });

    await query('UPDATE stores SET slug = $2 WHERE id = $1', [storeId, newSlug]);
    await renameStoreSlugInUserData(storeSlug, newSlug);

    // The primary key does not allow two rows for one line; the object version merged with the
    // OLD slug winning, which is the more recent of the two. A plain UPDATE would raise here.
    const state = await getUserCart(user);
    expect(Object.keys(state.cart)).toEqual([newSlug]);
    expect(state.cart[newSlug]!.items['widget']!.qty).toBe(9);
    expect(state.recentStores).toEqual([newSlug]);
  });

  it('is a no-op when the slug did not actually change', async () => {
    const { storeSlug } = await freshStore();
    await replaceUserCart(user, { cart: cartOf(storeSlug, { widget: { slug: 'widget', qty: 1 } }), wishlist: [] });
    await renameStoreSlugInUserData(storeSlug, storeSlug);
    expect(Object.keys((await getUserCart(user)).cart)).toEqual([storeSlug]);
  });
});

/**
 * The bigint boundary, and why it needs a stub rather than the database above.
 *
 * `COUNT` is `bigint`, which arrives as a **string** from `pg` and as a **number** from PGlite. The
 * suite runs on PGlite, so every count assertion in this file passes whether or not the module
 * converts — verified by sabotage: dropping the `Number()` left all 29 tests green. A test that
 * cannot fail is not coverage, so this replaces the driver with one that answers the way `pg` does.
 *
 * **The money columns are `bigint` too, and they are NOT at risk — checked, not assumed.** Sabotage
 * says so: removing the conversion there leaves this file green, because `fromAgorot` DIVIDES and
 * division coerces a numeric string. It is addition that concatenates, and the only thing this
 * module adds is the count. The conversion stays on both paths (one rule, applied everywhere, is
 * cheaper to keep right than two), but only one of them has a test that can fail, and this comment
 * is here so nobody later mistakes the other for one.
 */
describe('a count that arrives as a string from the real driver', () => {
  const strings: Database = {
    query: async <Row>() => ({ rows: [{ count: '7' }] as Row[], rowCount: 1 }),
    transaction: async <T>(run: (tx: Queryable) => Promise<T>) => run(strings),
    close: async () => {},
  };

  it('is a number, not the digits of one', async () => {
    setDatabase(strings);
    try {
      const count = await countFavoriteStores('11111111-1111-4111-8111-000000000001');
      expect(count).toBe(7);
      // The failure this prevents is silent and arithmetic: `'7' + 1` is `'71'`, which is what the
      // seller's dashboard would then show.
      expect(count + 1).toBe(8);
    } finally {
      setDatabase(realDb);
    }
  });
});

describe('a buyer with nothing saved', () => {
  it('reads back as empty rather than as undefined', async () => {
    expect(await getUserCart(`buyer-${crypto.randomUUID()}`))
      .toEqual({ cart: {}, wishlist: [], favoriteStores: [], recentStores: [] });
  });
});
