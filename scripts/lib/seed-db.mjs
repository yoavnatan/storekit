/**
 * The database half of the two seeders (`seed-demo-data.mjs`, `seed-showcase-stores.mjs`).
 *
 * **Why this file exists at all.** Both seeders wrote `data/sellers.json`, `data/stores.json`,
 * `data/store-products.json` and `data/store-categories.json`. Those four moved to Postgres during
 * stage 2 of DB_MIGRATION_PLAN.md and nothing reads them any more, so from the moment `sellers`
 * flipped the seeders **ran, printed a success line, and created nothing** — the quietest kind of
 * broken there is. They are translated here, in the session that moved `store-products`, because
 * fixing them earlier would have produced showcase stores with no products in them.
 *
 * **Why it duplicates a little of `db-import.mjs`.** That script maps the LEGACY files, with every
 * shape they drifted through over a year (§7.3); this one maps records a seeder just built, in one
 * known shape. Sharing a mapper would mean the seeder's clean input paying for the importer's
 * defensive normalisation, and the importer growing a second caller it must not break. The one
 * thing that genuinely must not diverge — `toAgorot`, whose rounding decides whether a seeded
 * price matches what the app shows — is imported, not copied.
 *
 * Scripts run under plain node and cannot import TypeScript, which is why this is `.mjs` and why
 * it talks SQL rather than calling `src/lib/store-products.ts`.
 */
import { randomUUID } from 'node:crypto';
import { toAgorot } from './db-import.mjs';
import { createClient, requireDatabaseUrl } from './pg-connect.mjs';

/** A connected client, or a clear exit — a seeder that starts fetching and only then discovers it
 *  has nowhere to write is how the previous version came to report success over an empty file. */
export async function openSeedClient() {
  const client = createClient(requireDatabaseUrl());
  await client.connect();
  return client;
}

/** Multi-row INSERT in chunks — the same reasoning (and the same 65,535 bind-parameter ceiling)
 *  as `db-import.mjs#insertMany`, which is not exported. */
async function insertMany(db, table, columns, rows) {
  if (!rows.length) return 0;
  const perChunk = Math.max(1, Math.min(1000, Math.floor(8000 / columns.length)));
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const params = [];
    const tuples = chunk.map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`);
    await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, params);
  }
  return rows.length;
}

/**
 * Remove whole stores and, optionally, the accounts that own them.
 *
 * Order matters and is enforced by the schema: `stores.seller_id` is `ON DELETE RESTRICT` (§7.9 —
 * an account with a store is not deleted out from under it), while everything hanging off a store
 * cascades. So the stores go first and take their categories, products, images, per-combo stock,
 * campaigns and analytics with them.
 *
 * @param {{ storeWhere?: string, sellerWhere?: string, params?: unknown[] }} scope
 */
export async function purge(db, scope) {
  const { storeWhere, sellerWhere, params = [] } = scope;
  let stores = 0;
  let sellers = 0;
  if (storeWhere) {
    const res = await db.query(`DELETE FROM stores WHERE ${storeWhere}`, params);
    stores = res.rowCount ?? 0;
  }
  if (sellerWhere) {
    const res = await db.query(`DELETE FROM sellers WHERE ${sellerWhere}`, params);
    sellers = res.rowCount ?? 0;
  }
  return { stores, sellers };
}

/**
 * Delete the orders belonging to the stores a purge is about to remove.
 *
 * **`purge` alone cannot do this, and that is not an oversight in the schema.** An order names its
 * store by SLUG, not by foreign key (§4 — a sold line is a snapshot, so a deleted store must not
 * take financial history with it), which means `DELETE FROM stores` cascades to that store's
 * products and categories and leaves its orders behind pointing at a slug nothing answers to. In
 * production that is exactly right. For a seeder it is a leak: every `npm run seed:demo` would
 * strand another set of demo orders that no store page, no revenue figure and no `--clean` could
 * ever reach again.
 *
 * Children first, because `order_items`/`order_stores` reference `orders` with `ON DELETE RESTRICT`
 * — the same rule that protects a real order from a careless cascade.
 */
export async function purgeOrdersOfStores(db, storeWhere, params = []) {
  const { rows } = await db.query(
    `SELECT DISTINCT os.order_id FROM order_stores os
      WHERE os.store_slug IN (SELECT slug::text FROM stores WHERE ${storeWhere})`, params,
  );
  const ids = rows.map((r) => r.order_id);
  if (!ids.length) return 0;
  await db.query('DELETE FROM order_items WHERE order_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM order_stores WHERE order_id = ANY($1::uuid[])', [ids]);
  const res = await db.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [ids]);
  return res.rowCount ?? 0;
}

/**
 * Replace a seeded catalog: drop the previous set, then write accounts, stores, each store's
 * category tree and its products.
 *
 * **The purge is part of the same transaction as the write, and that is the point.** Both seeders
 * fetch their photos and copy from the network first; a purge that committed on its own would mean
 * a run that then fails — no internet, a rejected row — has deleted the previous showcase stores
 * and put nothing in their place. As one statement sequence, a failure leaves exactly what was
 * there before. It is also why a half-finished run cannot leave stores with empty shelves, which
 * from the outside is indistinguishable from the bug this file was written to fix.
 *
 * Records are the same plain shapes the app's own types use (`Seller`, `Store`, `StoreCategory`,
 * `StoreProduct`), so a seeder builds what it always built and only the destination changed.
 * Categories are inserted parents-before-children, because `parent_id` is self-referencing.
 *
 * `orders` are written here too, since `orders` moved. Their money arrives in ILS, like the
 * product prices beside them, and converts through the same `toAgorot` — a seeder builds the plain
 * numbers a person would type, and this file is the one place that decides what an agora is.
 *
 * @param {{ purge?: { storeWhere?: string, sellerWhere?: string, params?: unknown[] },
 *           sellers?: any[], stores?: any[], categories?: any[], products?: any[],
 *           orders?: any[] }} catalog
 */
export async function writeCatalog(db, catalog) {
  const {
    purge: scope, sellers = [], stores = [], categories = [], products = [], orders = [],
    pageViews = [], favorites = [], wishlists = [],
  } = catalog;
  await db.query('BEGIN');
  try {
    // Orders before the stores that own them: `purge` deletes the stores, and once they are gone
    // there is no slug left to recognise their orders by (see purgeOrdersOfStores).
    if (scope?.storeWhere) await purgeOrdersOfStores(db, scope.storeWhere, scope.params ?? []);
    if (scope) await purge(db, scope);
    await insertMany(db, 'sellers', ['id', 'name', 'email', 'password_hash', 'created_at'],
      sellers.map((s) => [s.id, s.name ?? '', s.email, s.passwordHash ?? '', s.createdAt ?? null]));

    await insertMany(db, 'stores', [
      'id', 'seller_id', 'slug', 'name', 'tagline', 'description', 'colors', 'categories',
      'shipping', 'banner_image', 'profile_image', 'address', 'address_visible', 'hours',
      'hours_visible', 'demo', 'created_at',
    ], stores.map((s) => [
      s.id, s.sellerId, s.slug, s.name, s.tagline ?? '', s.description ?? '',
      JSON.stringify(s.colors ?? {}), s.categories ?? [], JSON.stringify(s.shipping ?? {}),
      s.bannerImage ?? null, s.profileImage ?? null, s.address ?? null,
      Boolean(s.addressVisible), s.hours ? JSON.stringify(s.hours) : null,
      Boolean(s.hoursVisible), Boolean(s.demo), s.createdAt ?? null,
    ]));

    const ids = new Set(categories.map((c) => c.id));
    await insertMany(db, 'store_categories', ['id', 'store_id', 'parent_id', 'name', 'position', 'created_at'],
      parentsFirst(categories, ids).map((c) => [
        c.id, c.storeId, c.parentId && ids.has(c.parentId) ? c.parentId : null,
        c.name, Number(c.order) || 0, c.createdAt ?? null,
      ]));

    const images = [];
    const variantStock = [];
    const variantImages = [];
    for (const p of products) {
      (p.images ?? []).forEach((url, i) => { if (url) images.push([p.id, i, url]); });
      for (const [combo, stock] of Object.entries(p.variantStock ?? {})) {
        variantStock.push([p.id, combo, Math.max(0, Number(stock) || 0), p.variantSku?.[combo] ?? null]);
      }
      // A combo carrying only a code keeps `stock` NULL — no override, sells from the shared pool
      // (migration 0003). Writing 0 here would seed a sold-out combo.
      for (const [combo, sku] of Object.entries(p.variantSku ?? {})) {
        if (!(combo in (p.variantStock ?? {}))) variantStock.push([p.id, combo, null, sku]);
      }
      for (const [option, url] of Object.entries(p.variantImages ?? {})) {
        if (url) variantImages.push([p.id, option, url]);
      }
    }

    await insertMany(db, 'store_products', [
      'id', 'store_id', 'slug', 'name', 'description', 'price_agorot', 'stock', 'sku',
      'category_id', 'hidden', 'blocked', 'tags', 'specs', 'variants', 'seller_note', 'created_at',
    ], products.map((p) => [
      p.id, p.storeId, p.slug, p.name, p.description ?? '',
      toAgorot(p.price), Math.max(0, Number(p.stock) || 0), p.sku || null,
      p.categoryId ?? null, Boolean(p.hidden), Boolean(p.blocked), p.tags ?? [],
      JSON.stringify(p.specs ?? []), JSON.stringify(p.variants ?? []), p.sellerNote || null,
      p.createdAt ?? null,
    ]));

    await insertMany(db, 'product_images', ['product_id', 'position', 'url'], images);
    await insertMany(db, 'product_variant_stock', ['product_id', 'combo_key', 'stock', 'sku'], variantStock);
    await insertMany(db, 'product_variant_images', ['product_id', 'option_value', 'url'], variantImages);

    const orderItems = [];
    const orderStores = [];
    for (const o of orders) {
      // `position` carries the line order, which an array had for free and a table does not
      // (migration 0004) — a seeded order should read the same way a real one does.
      (o.items ?? []).forEach((it, position) => orderItems.push([
        randomUUID(), o.id, it.productId ?? null, it.productName ?? '', it.productSlug ?? '',
        it.storeSlug ?? '', it.storeName ?? '', toAgorot(it.price), Math.max(1, Number(it.qty) || 1),
        it.image || null, it.selectedVariants ? JSON.stringify(it.selectedVariants) : null, position,
      ]));
      for (const [slug, sub] of Object.entries(o.storeSubtotals ?? {})) {
        orderStores.push([
          o.id, slug, sub.storeName ?? '', toAgorot(sub.subtotal), toAgorot(sub.shipping),
          sub.deliveryMethod || null,
        ]);
      }
    }
    await insertMany(db, 'orders', [
      'id', 'checkout_ref', 'buyer_id', 'buyer_name', 'buyer_email', 'buyer_phone',
      'buyer_city', 'buyer_street', 'buyer_zip', 'shipping_agorot', 'total_agorot',
      'payment_ref', 'payment_status', 'shipping_status', 'tracking_number', 'created_at', 'updated_at',
    ], orders.map((o) => [
      o.id, o.checkoutRef || null, o.buyerId || null,
      o.buyerName ?? '', o.buyerEmail ?? '', o.buyerPhone ?? '',
      o.buyerAddress?.city ?? '', o.buyerAddress?.street ?? '', o.buyerAddress?.zip || null,
      toAgorot(o.shippingAmount), toAgorot(o.totalAmount),
      o.paymentRef || null, o.paymentStatus ?? 'paid', o.shippingStatus ?? 'pending',
      o.trackingNumber || null, o.createdAt ?? null, o.updatedAt ?? o.createdAt ?? null,
    ]));
    await insertMany(db, 'order_items', [
      'id', 'order_id', 'product_id', 'product_name', 'product_slug', 'store_slug', 'store_name',
      'price_agorot', 'qty', 'image', 'selected_variants', 'position',
    ], orderItems);
    await insertMany(db, 'order_stores', [
      'order_id', 'store_slug', 'store_name', 'subtotal_agorot', 'shipping_agorot', 'delivery_method',
    ], orderStores);

    // Traffic history. Keyed by store ID (DB_MIGRATION_PLAN.md §5), so the purge above — which
    // deletes the stores, and cascades to both of these — has already cleared the previous run's.
    const viewDays = [];
    const viewVisitors = [];
    for (const pv of pageViews) {
      viewDays.push([pv.storeId, pv.day, Math.max(0, Number(pv.total) || 0)]);
      for (const visitorId of new Set(pv.visitors ?? [])) viewVisitors.push([pv.storeId, pv.day, visitorId]);
    }
    await insertMany(db, 'store_page_views', ['store_id', 'day', 'total'], viewDays);
    await insertMany(db, 'store_page_view_visitors', ['store_id', 'day', 'visitor_id'], viewVisitors);

    // Saved stores and wishlists — rows, not the two counter files they replace (§5). Both key by
    // id and both cascade from the purge above, so like the traffic history there is nothing to
    // carry across a re-seed. Seeding them as ROWS rather than as a number is what makes the demo
    // dashboard's figures the same COUNT(*) a real one shows: a seeded counter and a seeded set of
    // people can disagree, and only one of them is what the seller actually reads.
    await insertMany(db, 'favorite_stores', ['user_id', 'store_id'],
      favorites.map((f) => [f.userId, f.storeId]));
    await insertMany(db, 'wishlist_items', ['user_id', 'product_id'],
      wishlists.map((w) => [w.userId, w.productId]));

    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return {
    sellers: sellers.length, stores: stores.length,
    categories: categories.length, products: products.length, orders: orders.length,
    pageViews: pageViews.length, favorites: favorites.length, wishlists: wishlists.length,
  };
}

/** No row precedes its own parent — what a self-referencing foreign key needs when links are
 *  written with the rows rather than patched in afterwards. */
function parentsFirst(categories, ids) {
  const placed = new Set();
  const ordered = [];
  let remaining = categories;
  while (remaining.length) {
    const ready = remaining.filter((c) => !c.parentId || !ids.has(c.parentId) || placed.has(c.parentId));
    if (!ready.length) return [...ordered, ...remaining];
    for (const c of ready) { ordered.push(c); placed.add(c.id); }
    remaining = remaining.filter((c) => !placed.has(c.id));
  }
  return ordered;
}
