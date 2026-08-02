import { query, rows, withTransaction, type Queryable } from './db.js';
import { fromAgorot, toAgorot } from './money.js';
import { mergeStoreSlugs } from './recent-stores.js';
import type { CartItem } from './cart.js';
import type { WishlistItem } from './wishlist.js';

/**
 * Buyer state — the saved cart, the wishlist, the saved stores and the recently-visited list.
 *
 * **Moved to Postgres as one module (DB_MIGRATION_PLAN.md §5 + §8).** The three files this replaces
 * (`user-carts.ts`, `wishlist-counts.ts`, `store-favorite-counts.ts`) already shared one file on
 * disk — the last two read `data/user-carts.json` or a counter derived from it — so splitting them
 * across modules would only have hidden that they are one person's state.
 *
 * **Four tables, and the keys differ ON PURPOSE:**
 *
 * · `wishlist_items` and `favorite_stores` key by `uuid`, because a bare slug is not an identity:
 *   §7.1 measured 47 product slugs shared across different stores, so `wishlist-counts.json` — keyed
 *   by product slug alone — has been adding two unrelated products into one number all along. The
 *   application still speaks slugs, so every write resolves `(storeSlug, slug) → id` and every read
 *   joins back out to slugs. Nothing above this module changed shape.
 *
 * · `cart_items` keys by the TEXT `store_slug` + `cart_key` with no foreign key, and that is a
 *   decision rather than an omission. A cart line whose product was deleted must stay visible and
 *   marked (`CartItem.unavailable`, set by `applyServerPrices`) — a buyer who added three items and
 *   finds two has no idea what vanished. `ON DELETE CASCADE` would make the line disappear silently,
 *   which is the behaviour that field was written to prevent.
 *
 * **One line changes = one `UPDATE` of one row.** The old shape rewrote the entire nested cart of
 * every store on every quantity change, and three separate callers wrote "everything" in order to
 * change one field — which is how buying something came to wipe the buyer's recently-visited list
 * (the checkout's save simply omitted `recentStores`). The write paths are narrow now:
 * {@link setFavoriteStore} is one statement, {@link removeCartLines} is one statement, and
 * {@link replaceUserCart} — the sync endpoint, whose wire contract genuinely is a whole snapshot,
 * because the browser's `localStorage` is the other authority — writes it as a diff so an unchanged
 * row is not touched.
 */

export interface UserStoreCart {
  storeName: string;
  storeSlug: string;
  items: Record<string, CartItem>;
}

export interface UserCartData {
  cart: Record<string, UserStoreCart>;
  wishlist: WishlistItem[];
  favoriteStores?: string[];
  recentStores?: string[]; // recently-visited store slugs, newest-first (see recent-stores.ts)
}

/**
 * Ceilings on what one sync may store.
 *
 * The body cap (`BODY_LIMIT.collection`) bounds the BYTES a request may send; it does not bound the
 * ROWS they turn into, and a few hundred KB of minimal JSON is thousands of cart lines. A cart is a
 * person's shopping list, not a data store: these are far above any real one and far below a table
 * someone can grow for free. The snapshot is trimmed rather than rejected — a 400 here would leave
 * the browser retrying the same oversized payload forever.
 */
const MAX_CART_LINES = 300;
const MAX_WISHLIST_ITEMS = 300;

/**
 * Ceilings on the VALUES, which the row cap does not give.
 *
 * Four separate 500s were reachable from any signed-in account before these existed, and both
 * classes behind them have bitten this repo before:
 *
 * · **The column type is a limit.** `qty` is `integer` and the money columns are `bigint`, so
 *   `{"qty": 1e30}` is not a large cart — it is `value out of range`, raised by the INSERT. Same
 *   shape as the CHECK constraints that turned three silently-stored nonsense values into errors
 *   when `orders` moved: the write path clamps, and the column stays the backstop.
 *
 * · **The index is a limit too.** `cart_items` and `recent_stores` are keyed by their text columns,
 *   and a btree entry cannot exceed 2704 bytes — `index row size 8072 exceeds btree version 4
 *   maximum`. This is `MAX_CATEGORY_NAME_LENGTH` again, where a `maxlength` in a form was the only
 *   rule and a hand-made POST walked around it.
 *
 * **Identity fields drop the line; display fields are trimmed.** Truncating a `cart_key` would
 * change which line it IS, so the next sync would add a second copy beside it; and no real key —
 * a product slug plus a variant combo — comes near these numbers, so a value over them is not a
 * cart line at all. A name or an image URL carries no identity, so it is cut and the line kept.
 */
const MAX_SLUG_LEN = 200;
const MAX_CART_KEY_LEN = 400;
const MAX_NAME_LEN = 200;
const MAX_IMAGE_LEN = 2_000;
const MAX_QTY = 10_000;
/** ₪10,000,000 in agorot — beyond any price, far inside `bigint`. */
const MAX_PRICE_AGOROT = 1_000_000_000;
const MAX_VARIANT_ENTRIES = 20;
const MAX_VARIANT_TEXT_LEN = 100;

function trim(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max);
}

function clampAgorot(ils: unknown): number {
  const agorot = toAgorot(Number(ils) || 0);
  return Math.min(MAX_PRICE_AGOROT, Math.max(0, Number.isFinite(agorot) ? agorot : 0));
}

/** Only string→string pairs, bounded — it goes into `jsonb` straight from the request. */
function cleanVariants(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_VARIANT_ENTRIES)) {
    if (typeof v !== 'string') continue;
    out[trim(k, MAX_VARIANT_TEXT_LEN)] = trim(v, MAX_VARIANT_TEXT_LEN);
  }
  return Object.keys(out).length ? out : null;
}

interface CartRow {
  store_slug: string;
  cart_key: string;
  store_name: string;
  product_slug: string;
  product_name: string;
  price_agorot: number | string;
  base_price_agorot: number | string | null;
  image: string | null;
  qty: number;
  selected_variants: Record<string, string> | null;
}

interface WishlistRow {
  slug: string;
  name: string;
  price_agorot: number | string;
  image: string | null;
  store_slug: string;
  store_name: string;
  stock: number;
}

/** `bigint` comes back as a string from `pg` and a number from PGlite — one conversion at the edge. */
function agorotToIls(value: number | string | null | undefined): number {
  return fromAgorot(Number(value ?? 0));
}

function toStoreCarts(cartRows: CartRow[]): Record<string, UserStoreCart> {
  const cart: Record<string, UserStoreCart> = {};
  for (const row of cartRows) {
    const group = cart[row.store_slug] ??= {
      storeName: row.store_name,
      storeSlug: row.store_slug,
      items: {},
    };
    const item: CartItem = {
      cartKey: row.cart_key,
      slug: row.product_slug,
      name: row.product_name,
      price: agorotToIls(row.price_agorot),
      image: row.image ?? '',
      qty: row.qty,
    };
    if (row.base_price_agorot !== null) item.basePrice = agorotToIls(row.base_price_agorot);
    if (row.selected_variants && Object.keys(row.selected_variants).length) {
      item.selectedVariants = row.selected_variants;
    }
    group.items[row.cart_key] = item;
  }
  return cart;
}

/**
 * The wishlist, rebuilt from the products it points at rather than from a snapshot taken when the
 * heart was clicked.
 *
 * That is a change in behaviour and the better one: the JSON version stored the name, price and
 * photo as they were on the day the buyer saved the item, so a price cut never showed up in the
 * drawer. Joining to the product means a deleted product simply stops appearing (`ON DELETE
 * CASCADE` on `wishlist_items.product_id`), and a renamed or repriced one reads correctly.
 */
const WISHLIST_SELECT = `
  SELECT p.slug::text AS slug, p.name, p.price_agorot, p.stock,
         s.slug::text AS store_slug, s.name AS store_name,
         (SELECT i.url FROM product_images i WHERE i.product_id = p.id ORDER BY i.position LIMIT 1) AS image
    FROM wishlist_items w
    JOIN store_products p ON p.id = w.product_id
    JOIN stores s ON s.id = p.store_id AND s.deleted_at IS NULL
   WHERE w.user_id = $1
   ORDER BY w.added_at, p.id`;

function toWishlist(wishRows: WishlistRow[]): WishlistItem[] {
  return wishRows.map((row) => ({
    slug: row.slug,
    name: row.name,
    price: agorotToIls(row.price_agorot),
    image: row.image ?? '',
    storeSlug: row.store_slug,
    storeName: row.store_name,
    stock: row.stock,
  }));
}

/** The full state, for the sync endpoint that hands the browser everything it has. */
export async function getUserCart(userId: string): Promise<UserCartData> {
  const [cartRows, wishRows, favorites, recent] = await Promise.all([
    rows<CartRow>(
      `SELECT store_slug, cart_key, store_name, product_slug, product_name, price_agorot,
              base_price_agorot, image, qty, selected_variants
         FROM cart_items WHERE user_id = $1 ORDER BY store_slug, added_at, cart_key`,
      [userId],
    ),
    rows<WishlistRow>(WISHLIST_SELECT, [userId]),
    getFavoriteStoresForUser(userId),
    getRecentStoresForUser(userId),
  ]);
  return { cart: toStoreCarts(cartRows), wishlist: toWishlist(wishRows), favoriteStores: favorites, recentStores: recent };
}

/** Saved-store slugs. A store that was deleted or renamed is answered by the join, not by a rewrite. */
export async function getFavoriteStoresForUser(userId: string): Promise<string[]> {
  const found = await rows<{ slug: string }>(
    `SELECT s.slug::text AS slug FROM favorite_stores f
       JOIN stores s ON s.id = f.store_id AND s.deleted_at IS NULL
      WHERE f.user_id = $1 ORDER BY f.added_at, s.id`,
    [userId],
  );
  return found.map((r) => r.slug);
}

/** The homepage's "ביקרת לאחרונה" shelf — the account half of it (the cookie half is per-browser). */
export async function getRecentStoresForUser(userId: string): Promise<string[]> {
  const found = await rows<{ store_slug: string }>(
    'SELECT store_slug FROM recent_stores WHERE user_id = $1 ORDER BY position',
    [userId],
  );
  return found.map((r) => r.store_slug);
}

/** Does this person have this store saved? One row, not the whole list, for the store page's heart. */
export async function isStoreFavorited(userId: string, storeId: string): Promise<boolean> {
  const { rowCount } = await query(
    'SELECT 1 FROM favorite_stores WHERE user_id = $1 AND store_id = $2',
    [userId, storeId],
  );
  return rowCount > 0;
}

/**
 * Toggle a saved store, and answer which way it went.
 *
 * The affected-row count is the verdict (§7.5) — no read that precedes the write, so two tabs
 * clicking the heart at the same moment end in one consistent state instead of two writes that each
 * believed the other's starting point.
 */
export async function toggleFavoriteStore(userId: string, storeId: string): Promise<boolean> {
  const inserted = await query(
    'INSERT INTO favorite_stores (user_id, store_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [userId, storeId],
  );
  if (inserted.rowCount > 0) return true;
  await query('DELETE FROM favorite_stores WHERE user_id = $1 AND store_id = $2', [userId, storeId]);
  return false;
}

/**
 * How many people saved this store — `COUNT(*)` on the real table (§5).
 *
 * The file it replaces was a stored counter, and a stored counter always drifts from the truth
 * eventually; this one cannot, because there is nothing to keep in step.
 */
export async function countFavoriteStores(storeId: string): Promise<number> {
  const found = await rows<{ count: number | string }>(
    'SELECT COUNT(*) AS count FROM favorite_stores WHERE store_id = $1',
    [storeId],
  );
  return Number(found[0]?.count ?? 0);
}

/**
 * Wishlist counts for one store's products, keyed by product slug.
 *
 * **Keyed by slug and that is safe HERE, where the whole file was not**: §7.1 measured zero
 * duplicate slugs within a single store and 47 across stores, so a per-store map cannot collide
 * while a platform-wide one always could. It is also the reason this is scoped at all — the seller
 * dashboard and `/api/seller/products` used to read every wishlist count on the platform in order
 * to label the products of one store.
 */
export async function getWishlistCountsForStore(storeId: string): Promise<Record<string, number>> {
  const found = await rows<{ slug: string; count: number | string }>(
    `SELECT p.slug::text AS slug, COUNT(*) AS count
       FROM wishlist_items w JOIN store_products p ON p.id = w.product_id
      WHERE p.store_id = $1 GROUP BY p.slug`,
    [storeId],
  );
  const counts: Record<string, number> = {};
  for (const row of found) counts[row.slug] = Number(row.count);
  return counts;
}

/** A cart line's identity, as the checkout names it when the buyer has paid for it. */
export interface CartLineRef {
  storeSlug: string;
  cartKey: string;
}

/**
 * Drop exactly the lines that were bought, in one statement.
 *
 * The whole of the rest of the buyer's state — the lines they left unselected, the wishlist, the
 * saved stores, the recently-visited list — is untouched because it is not in this statement. The
 * shape this replaces had to rebuild the cart object and hand back every other field with it, and
 * the field it forgot to hand back (`recentStores`) was silently emptied on every purchase.
 */
export async function removeCartLines(userId: string, lines: readonly CartLineRef[]): Promise<void> {
  if (lines.length === 0) return;
  await query(
    `DELETE FROM cart_items c USING unnest($2::text[], $3::text[]) AS k(store_slug, cart_key)
      WHERE c.user_id = $1 AND c.store_slug = k.store_slug AND c.cart_key = k.cart_key`,
    [userId, lines.map((l) => l.storeSlug), lines.map((l) => l.cartKey)],
  );
}

interface CartSnapshotInput {
  cart: Record<string, UserStoreCart>;
  wishlist: WishlistItem[];
  recentStores?: string[];
}

/** Flatten the posted object into rows, capped, with the group key winning over any `storeSlug`
 *  the client wrote inside the group (the object key is what the browser stores under). */
function flattenCart(cart: Record<string, UserStoreCart>): CartRow[] {
  const flat: CartRow[] = [];
  for (const [storeSlug, group] of Object.entries(cart ?? {})) {
    if (!storeSlug || storeSlug.length > MAX_SLUG_LEN) continue;
    if (typeof group !== 'object' || group === null) continue;
    for (const [cartKey, item] of Object.entries(group.items ?? {})) {
      if (!cartKey || cartKey.length > MAX_CART_KEY_LEN) continue;
      if (typeof item !== 'object' || item === null) continue;
      if (flat.length >= MAX_CART_LINES) return flat;
      flat.push({
        store_slug: storeSlug,
        cart_key: cartKey,
        store_name: trim(group.storeName, MAX_NAME_LEN),
        product_slug: trim(item.slug, MAX_SLUG_LEN),
        product_name: trim(item.name, MAX_NAME_LEN),
        price_agorot: clampAgorot(item.price),
        base_price_agorot: item.basePrice === undefined ? null : clampAgorot(item.basePrice),
        image: item.image ? trim(item.image, MAX_IMAGE_LEN) : null,
        qty: Math.min(MAX_QTY, Math.max(1, Math.floor(Number(item.qty) || 1))),
        selected_variants: cleanVariants(item.selectedVariants),
      });
    }
  }
  return flat;
}

/**
 * Replace this person's cart, wishlist and recent-stores list with the browser's snapshot.
 *
 * **A snapshot on the wire, a diff in the database.** The client posts everything because
 * `localStorage` is the other authority and the merge on login has to see both sides; but the write
 * touches only what differs — `ON CONFLICT … DO UPDATE … WHERE IS DISTINCT FROM` makes an unchanged
 * line a no-op, so a quantity change is one `UPDATE` of one row (§5) even though the request
 * carried the whole cart.
 *
 * Saved stores are absent from this by design: they are their own table, written only by the heart,
 * so unlike the file version there is nothing here to preserve them FROM. The bug class where one
 * writer clobbers another writer's field cannot be expressed.
 */
export async function replaceUserCart(userId: string, snapshot: CartSnapshotInput): Promise<void> {
  const cartRows = flattenCart(snapshot.cart);
  // The length gate here is NOT the same kind as the two above it, and the difference is worth
  // knowing before anyone tidies them together: a wishlist slug is only ever a query parameter that
  // fails to join, so removing this changes nothing observable (sabotage confirms the tests stay
  // green). The cart and recent-store gates guard an INDEX, and removing either is a 500.
  const wishlist = (snapshot.wishlist ?? []).slice(0, MAX_WISHLIST_ITEMS).filter((w) =>
    w && typeof w.slug === 'string' && typeof w.storeSlug === 'string'
    && w.slug.length <= MAX_SLUG_LEN && w.storeSlug.length <= MAX_SLUG_LEN);
  const recent = snapshot.recentStores?.filter((s) => s && s.length <= MAX_SLUG_LEN);

  await withTransaction(async (tx) => {
    await writeCartLines(tx, userId, cartRows);
    await writeWishlist(tx, userId, wishlist);
    if (recent) await writeRecentStores(tx, userId, recent);
  });
}

async function writeCartLines(tx: Queryable, userId: string, cartRows: CartRow[]): Promise<void> {
  const cols = [
    cartRows.map((r) => r.store_slug), cartRows.map((r) => r.cart_key), cartRows.map((r) => r.store_name),
    cartRows.map((r) => r.product_slug), cartRows.map((r) => r.product_name), cartRows.map((r) => r.price_agorot),
    cartRows.map((r) => r.base_price_agorot), cartRows.map((r) => r.image), cartRows.map((r) => r.qty),
    cartRows.map((r) => (r.selected_variants ? JSON.stringify(r.selected_variants) : null)),
  ];
  await tx.query(
    `INSERT INTO cart_items (user_id, store_slug, cart_key, store_name, product_slug, product_name,
                             price_agorot, base_price_agorot, image, qty, selected_variants)
     SELECT $1, k.store_slug, k.cart_key, k.store_name, k.product_slug, k.product_name,
            k.price_agorot, k.base_price_agorot, k.image, k.qty, k.selected_variants
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[],
                   $8::bigint[], $9::text[], $10::integer[], $11::jsonb[])
            AS k(store_slug, cart_key, store_name, product_slug, product_name, price_agorot,
                 base_price_agorot, image, qty, selected_variants)
     ON CONFLICT (user_id, store_slug, cart_key) DO UPDATE
        SET store_name = EXCLUDED.store_name, product_slug = EXCLUDED.product_slug,
            product_name = EXCLUDED.product_name, price_agorot = EXCLUDED.price_agorot,
            base_price_agorot = EXCLUDED.base_price_agorot, image = EXCLUDED.image,
            qty = EXCLUDED.qty, selected_variants = EXCLUDED.selected_variants
      WHERE (cart_items.store_name, cart_items.product_slug, cart_items.product_name,
             cart_items.price_agorot, cart_items.base_price_agorot, cart_items.image,
             cart_items.qty, cart_items.selected_variants)
         IS DISTINCT FROM
            (EXCLUDED.store_name, EXCLUDED.product_slug, EXCLUDED.product_name,
             EXCLUDED.price_agorot, EXCLUDED.base_price_agorot, EXCLUDED.image,
             EXCLUDED.qty, EXCLUDED.selected_variants)`,
    [userId, ...cols],
  );
  await tx.query(
    `DELETE FROM cart_items c
      WHERE c.user_id = $1
        AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS k(store_slug, cart_key)
                         WHERE k.store_slug = c.store_slug AND k.cart_key = c.cart_key)`,
    [userId, cartRows.map((r) => r.store_slug), cartRows.map((r) => r.cart_key)],
  );
}

/**
 * The wishlist, resolved from `(storeSlug, slug)` to product ids inside the statement.
 *
 * An entry naming a product that no longer exists is simply not resolved and not written — the same
 * answer the drawer already gives, since it renders from the product. Doing the lookup in SQL keeps
 * it one round trip and means the FK can never be handed an id that was true a moment ago.
 */
async function writeWishlist(tx: Queryable, userId: string, wishlist: readonly WishlistItem[]): Promise<void> {
  const storeSlugs = wishlist.map((w) => w.storeSlug);
  const productSlugs = wishlist.map((w) => w.slug);
  await tx.query(
    `INSERT INTO wishlist_items (user_id, product_id)
     SELECT DISTINCT $1, p.id
       FROM unnest($2::text[], $3::text[]) AS k(store_slug, product_slug)
       JOIN stores s ON s.slug = k.store_slug AND s.deleted_at IS NULL
       JOIN store_products p ON p.store_id = s.id AND p.slug = k.product_slug
     ON CONFLICT DO NOTHING`,
    [userId, storeSlugs, productSlugs],
  );
  await tx.query(
    `DELETE FROM wishlist_items w
      WHERE w.user_id = $1
        AND NOT EXISTS (
              SELECT 1 FROM unnest($2::text[], $3::text[]) AS k(store_slug, product_slug)
                JOIN stores s ON s.slug = k.store_slug
                JOIN store_products p ON p.store_id = s.id AND p.slug = k.product_slug
               WHERE p.id = w.product_id)`,
    [userId, storeSlugs, productSlugs],
  );
}

/**
 * This device's recently-visited list, unioned with what other devices recorded.
 *
 * **The read is inside the same transaction as the write**, which is the point: the list is per
 * DEVICE (a first-party cookie) and per account at once, so a sync has to see the stored list to
 * add to it rather than replace it. Reading it in the route and passing the union down would put
 * the read outside the write's transaction — the `await`-in-the-middle shape that turned
 * `bulkUpsertProducts` into a lost update.
 *
 * `mergeStoreSlugs` is device-first (this browser's recency wins) and caps the result, so `position`
 * 0 is the most recently visited store and the list cannot grow.
 */
async function writeRecentStores(tx: Queryable, userId: string, slugs: readonly string[]): Promise<void> {
  const { rows: stored } = await tx.query<{ store_slug: string }>(
    'SELECT store_slug FROM recent_stores WHERE user_id = $1 ORDER BY position', [userId]);
  const merged = mergeStoreSlugs([...slugs], stored.map((r) => r.store_slug));
  await tx.query('DELETE FROM recent_stores WHERE user_id = $1', [userId]);
  if (merged.length === 0) return;
  await tx.query(
    `INSERT INTO recent_stores (user_id, store_slug, position)
     SELECT $1, k.slug, (k.pos - 1)::integer
       FROM unnest($2::text[]) WITH ORDINALITY AS k(slug, pos)
     ON CONFLICT DO NOTHING`,
    [userId, merged],
  );
}

/**
 * Carry a renamed store's slug across the buyer state that is stored BY slug.
 *
 * **Only two of the four tables are here now, and that is the point of the uuid keys.** Saved stores
 * and wishlist entries key by `store_id` / `product_id`, so a URL change cannot orphan them and
 * there is nothing to migrate — the same reason `renameStoreSlugInPageviews` was deleted outright
 * when the view buckets moved. Cart lines and the recent list still key by slug (see the note at the
 * top of this file), so they still move.
 *
 * The pre-`UPDATE` delete is the collision case the object version handled by merging: a buyer can
 * hold lines under both slugs at once — the store renamed while an old tab still had its cart open —
 * and the primary key does not allow two. The line under the OLD slug wins, which is what the merge
 * did (`{...existing, ...moved}`) and is the more recent of the two by definition.
 */
export async function renameStoreSlugInUserData(oldSlug: string, newSlug: string): Promise<void> {
  if (!oldSlug || oldSlug === newSlug) return;
  await withTransaction(async (tx) => {
    await tx.query(
      `DELETE FROM cart_items n
        WHERE n.store_slug = $2
          AND EXISTS (SELECT 1 FROM cart_items o
                       WHERE o.user_id = n.user_id AND o.store_slug = $1 AND o.cart_key = n.cart_key)`,
      [oldSlug, newSlug],
    );
    await tx.query('UPDATE cart_items SET store_slug = $2 WHERE store_slug = $1', [oldSlug, newSlug]);
    await tx.query(
      `DELETE FROM recent_stores n
        WHERE n.store_slug = $2
          AND EXISTS (SELECT 1 FROM recent_stores o WHERE o.user_id = n.user_id AND o.store_slug = $1)`,
      [oldSlug, newSlug],
    );
    await tx.query('UPDATE recent_stores SET store_slug = $2 WHERE store_slug = $1', [oldSlug, newSlug]);
  });
}
