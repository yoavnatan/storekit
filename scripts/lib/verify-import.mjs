// Proof that the import landed intact — DB_MIGRATION_PLAN.md §9.
//
// The reason this file exists at all: a migration that "works" can be quietly wrong. Every table
// fills, every page renders, nothing throws — and a third of the catalogue is missing from the
// storefront because an optional flag imported as NULL, or the analytics graphs look like a slow
// month because half the buckets never arrived. Those failures produce no error to notice. Each
// check below is an ANCHOR: one number computed from the JSON files and the same number computed
// from the database, so a silent loss becomes a loud one.
//
// The four that catch the silent class specifically:
//   · visible products (§7.12) — the NULL-vs-false flag bug, caught within a minute of the import
//   · nested fields (§7.14) — row counts and money totals both pass while variants import empty
//   · counter sums (§7.15) — the analytics buckets have neither money nor rows to compare against
//   · money total (§9.4) — the only check that proves the agorot conversion lost nothing
import fs from 'node:fs';
import path from 'node:path';
import { toAgorot } from './db-import.mjs';

function readJson(dataDir, name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')); }
  catch { return fallback; }
}

function bucketTotal(value) {
  if (typeof value === 'number') return value;
  return Number(value?.total) || 0;
}

async function scalar(db, sql) {
  const { rows } = await db.query(sql, []);
  return Number(Object.values(rows[0] ?? {})[0] ?? 0);
}

/**
 * Run every check. `skipped` is the import's own report of rows it could not write — a check whose
 * shortfall is exactly the number of deliberately dropped rows passes, and SAYS so, rather than
 * failing for a known reason or, worse, being loosened until it passes.
 *
 * @typedef {{ name: string, expected: number, actual: number, ok: boolean, note?: string }} Check
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }} db
 * @param {{ dataDir?: string, skipped?: { what: string, reason: string, count: number }[] }} [options]
 * @returns {Promise<Check[]>}
 */
export async function verifyImport(db, { dataDir = path.join(process.cwd(), 'data'), skipped = [] } = {}) {
  /** @type {Check[]} */
  const checks = [];
  const dropped = (what) => skipped.filter((s) => s.what === what).reduce((n, s) => n + s.count, 0);
  const check = (name, expected, actual, note) =>
    checks.push({ name, expected, actual, ok: expected === actual, note });

  // --- §9.3 row counts -----------------------------------------------------
  const sellers = readJson(dataDir, 'sellers.json', []);
  const stores = readJson(dataDir, 'stores.json', []);
  const products = readJson(dataDir, 'store-products.json', []);
  const categories = readJson(dataDir, 'store-categories.json', []);
  const orders = readJson(dataDir, 'orders.json', []);

  check('sellers', sellers.length - dropped('seller'), await scalar(db, 'SELECT COUNT(*) FROM sellers'));
  check('stores', stores.length - dropped('store'), await scalar(db, 'SELECT COUNT(*) FROM stores'));
  check('store_categories', categories.length - dropped('category'), await scalar(db, 'SELECT COUNT(*) FROM store_categories'));
  check('store_products', products.length - dropped('product'), await scalar(db, 'SELECT COUNT(*) FROM store_products'));
  check('orders', orders.length, await scalar(db, 'SELECT COUNT(*) FROM orders'));
  check('order_items', orders.reduce((n, o) => n + (o.items?.length ?? 0), 0),
    await scalar(db, 'SELECT COUNT(*) FROM order_items'));
  check('order_stores', orders.reduce((n, o) => n + Object.keys(o.storeSubtotals ?? {}).length, 0),
    await scalar(db, 'SELECT COUNT(*) FROM order_stores'));
  check('money_events', readJson(dataDir, 'money-events.json', []).length,
    await scalar(db, 'SELECT COUNT(*) FROM money_events'));

  check('messages', readJson(dataDir, 'messages.json', []).length,
    await scalar(db, 'SELECT COUNT(*) FROM messages'));
  check('notifications', readJson(dataDir, 'notifications.json', []).length,
    await scalar(db, 'SELECT COUNT(*) FROM notifications'));
  // Added with the messaging move (2026-08-02). This table had no anchor at all, and it is the one
  // that carries the platform's own record of a block and the seller's appeal to it — the rows
  // whose loss would be least visible and worst to lose.
  check('admin_messages', readJson(dataDir, 'admin-messages.json', []).length - dropped('admin message'),
    await scalar(db, 'SELECT COUNT(*) FROM admin_messages'));
  check('error_log', readJson(dataDir, 'error-log.json', []).length,
    await scalar(db, 'SELECT COUNT(*) FROM error_log'));
  check('ad_campaigns', readJson(dataDir, 'ad-campaigns.json', []).length - dropped('ad campaign'),
    await scalar(db, 'SELECT COUNT(*) FROM ad_campaigns'));

  // Two kinds of check live below, and mixing them up is what produced three wrong anchors at once:
  //
  //  · The ROW COUNTS above ask "did the rows arrive", so they may subtract `dropped(...)` — the
  //    import's declared account of rows it could not write, printed in full and asserted by
  //    tests/db-import.test.ts.
  //  · Everything after this point asks "did the FIELDS arrive", which is a different question. It
  //    is computed over the JSON rows that actually landed, because subtracting a whole-table drop
  //    count from a FILTERED subset is arithmetic about two different sets: one dropped store with
  //    no opening hours made `stores.filter(s => s.hours).length - dropped('store')` expect zero
  //    stores with hours, and one dropped product's price made the price total short by exactly
  //    that price.
  const landedStoreIds = new Set((await db.query('SELECT id FROM stores', [])).rows.map((r) => r.id));
  const landedProductIds = new Set((await db.query('SELECT id FROM store_products', [])).rows.map((r) => r.id));
  const landedStoreSlugs = new Set((await db.query('SELECT slug FROM stores', [])).rows.map((r) => String(r.slug)));
  const liveStores = stores.filter((s) => landedStoreIds.has(s.id));
  const liveProducts = products.filter((p) => landedProductIds.has(p.id));
  // --- §9.4 money ----------------------------------------------------------
  // The single check that proves the ILS→agorot conversion lost nothing. Summed the same way the
  // application sums money (per-row rounding, then addition) so the comparison is like for like.
  check('order money total (agorot)',
    orders.reduce((n, o) => n + toAgorot(o.totalAmount), 0),
    await scalar(db, 'SELECT COALESCE(SUM(total_agorot),0) FROM orders'),
    'ILS→agorot conversion');
  check('order line money total (agorot)',
    orders.reduce((n, o) => n + (o.items ?? []).reduce((m, i) => m + toAgorot(i.price) * (Number(i.qty) || 1), 0), 0),
    await scalar(db, 'SELECT COALESCE(SUM(price_agorot * qty),0) FROM order_items'));
  check('product price total (agorot)',
    liveProducts.reduce((n, p) => n + toAgorot(p.price), 0),
    await scalar(db, 'SELECT COALESCE(SUM(price_agorot),0) FROM store_products'));

  // Added with the advertising move (2026-08-02). Three budgets crossed ILS→agorot in that diff and
  // none of them had an anchor: campaign budgets are the money the platform bills a seller onward
  // (platform-revenue.ts), and the baseline lifetime budget is the platform's own cap. A budget
  // imported unconverted reads as a hundredth of itself — a number that still renders, still sums,
  // and is simply wrong on the screen that reports committed ad spend.
  // Over the campaigns that LANDED, not every campaign in the file — one whose store is missing is
  // dropped, and summing the file's would be the filtered-subset-minus-whole-table-drop mistake the
  // note above records.
  const landedCampaigns = readJson(dataDir, 'ad-campaigns.json', [])
    .filter((c) => landedStoreIds.has(c.storeId));
  check('boost campaign budget total (agorot)',
    landedCampaigns.reduce((n, c) => n + toAgorot(c.monthlyBudget), 0),
    await scalar(db, 'SELECT COALESCE(SUM(monthly_budget_agorot),0) FROM ad_campaigns'),
    'ILS→agorot conversion');
  const brandCampaigns = readJson(dataDir, 'brand-campaigns.json', []);
  check('brand campaign budget total (agorot)',
    brandCampaigns.reduce((n, c) => n + toAgorot(c.monthlyBudget), 0),
    await scalar(db, 'SELECT COALESCE(SUM(monthly_budget_agorot),0) FROM brand_campaigns'),
    'ILS→agorot conversion');
  // A jsonb value has no column type to sum, so this reads the one key out of the settings row.
  check('baseline lifetime budget (agorot)',
    toAgorot(readJson(dataDir, 'platform-ads.json', {}).lifetimeBudget),
    await scalar(db, `SELECT COALESCE((value ->> 'lifetimeBudgetAgorot')::bigint, 0)
                        FROM app_settings WHERE key = 'platform_ads'`),
    'ILS→agorot conversion');

  // --- §7.12 / §9.8 the silent NULL-flag bug -------------------------------
  // isProductVisible === !blocked && !hidden. If a flag imported as NULL the SQL predicate stops
  // matching that row and the product vanishes from the storefront with no error anywhere.
  check('visible products (isProductVisible)',
    liveProducts.filter((p) => !p.blocked && !p.hidden).length,
    await scalar(db, 'SELECT COUNT(*) FROM store_products WHERE NOT hidden AND NOT blocked'),
    '§7.12 — NULL vs false');
  check('visible stores (not blocked)',
    liveStores.filter((s) => !s.blocked).length,
    await scalar(db, 'SELECT COUNT(*) FROM stores WHERE NOT blocked'));

  // --- §7.14 / §9.6 nested fields ------------------------------------------
  // Row counts and money totals both pass while variants, variant stock and opening hours import
  // empty: the product row exists and simply has no stock for any combination.
  check('products with variants',
    liveProducts.filter((p) => (p.variants ?? []).length).length,
    await scalar(db, "SELECT COUNT(*) FROM store_products WHERE jsonb_array_length(variants) > 0"),
    '§7.14');
  check('variant stock entries',
    liveProducts.reduce((n, p) => n + new Set([
      ...Object.keys(p.variantStock ?? {}), ...Object.keys(p.variantSku ?? {}),
    ]).size, 0),
    await scalar(db, 'SELECT COUNT(*) FROM product_variant_stock'), '§7.14');
  check('variant stock units',
    liveProducts.reduce((n, p) => n + Object.values(p.variantStock ?? {}).reduce((m, v) => m + (Number(v) || 0), 0), 0),
    await scalar(db, 'SELECT COALESCE(SUM(stock),0) FROM product_variant_stock'), '§7.14');
  check('product images',
    liveProducts.reduce((n, p) => n + (p.images ?? []).filter(Boolean).length, 0),
    await scalar(db, 'SELECT COUNT(*) FROM product_images'), '§7.14');
  check('stores with opening hours',
    liveStores.filter((s) => s.hours).length,
    await scalar(db, 'SELECT COUNT(*) FROM stores WHERE hours IS NOT NULL'), '§7.14');
  check('products with specs',
    liveProducts.filter((p) => (p.specs ?? []).length).length,
    await scalar(db, "SELECT COUNT(*) FROM store_products WHERE jsonb_array_length(specs) > 0"), '§7.14');

  // --- §7.15 / §9.7 the buckets, which have no money and no rows to anchor on
  const storeViews = readJson(dataDir, 'store-pageviews.json', {});
  const storeViewTotal = Object.entries(storeViews)
    .filter(([slug]) => landedStoreSlugs.has(slug))
    .reduce((n, [, days]) => n + Object.values(days).reduce((m, v) => m + bucketTotal(v), 0), 0);
  check('store page-view total (live stores)', storeViewTotal,
    await scalar(db, 'SELECT COALESCE(SUM(total),0) FROM store_page_views'),
    `§7.15 — ${dropped('store page-views')} bucket(s) belong to a store that never landed`);

  const productViews = readJson(dataDir, 'product-pageviews.json', {});
  // Buckets belonging to deleted products cannot be written (the foreign key is the point), so the
  // expectation subtracts exactly those rather than the check being relaxed.
  const liveProductIds = new Set(
    (await db.query('SELECT id FROM store_products', [])).rows.map((r) => r.id),
  );
  const productViewTotal = Object.entries(productViews)
    .filter(([id]) => liveProductIds.has(id))
    .reduce((n, [, days]) => n + Object.values(days).reduce((m, v) => m + bucketTotal(v), 0), 0);
  check('product page-view total (live products)', productViewTotal,
    await scalar(db, 'SELECT COALESCE(SUM(total),0) FROM product_page_views'),
    `§7.15 — ${dropped('product page-views')} bucket(s) belong to deleted products`);

  const analytics = readJson(dataDir, 'analytics-events.json', {});
  let analyticsCount = 0;
  let analyticsVisitors = 0;
  for (const events of Object.values(analytics)) {
    for (const bucket of Object.values(events ?? {})) {
      analyticsCount += Number(bucket?.count) || 0;
      analyticsVisitors += new Set(bucket?.visitors ?? []).size;
    }
  }
  check('analytics event total', analyticsCount,
    await scalar(db, 'SELECT COALESCE(SUM(count),0) FROM analytics_daily'), '§7.15');
  check('analytics distinct-session rows', analyticsVisitors,
    await scalar(db, 'SELECT COUNT(*) FROM analytics_visitors'), '§7.15');

  // --- buyer state ---------------------------------------------------------
  const carts = readJson(dataDir, 'user-carts.json', {});
  const cartLines = Object.values(carts).reduce((n, d) =>
    n + Object.values(d.cart ?? {}).reduce((m, s) => m + Object.keys(s.items ?? {}).length, 0), 0);
  check('cart lines', cartLines, await scalar(db, 'SELECT COUNT(*) FROM cart_items'));
  check('cart units',
    Object.values(carts).reduce((n, d) => n + Object.values(d.cart ?? {})
      .reduce((m, s) => m + Object.values(s.items ?? {}).reduce((k, i) => k + (Number(i.qty) || 0), 0), 0), 0),
    await scalar(db, 'SELECT COALESCE(SUM(qty),0) FROM cart_items'));

  // The three tables below sat in the same file as `cart_items` and had no anchor of their own,
  // which is exactly how the wishlist arrived empty: the import keys a wishlist entry by
  // "storeSlug\u0000productSlug", the two sides of that key drifted to different separators, and
  // every one of the 16 rows was dropped as "product no longer exists". Row counts, money totals
  // and the cart checks all passed while it happened. An unanchored table is an unimported table.
  //
  // These three deliberately do NOT subtract `dropped(...)` the way the page-view checks above do.
  // A drop is the import's own account of what it could not write, and here the drop reason was
  // the bug's own alibi — subtracting it makes the check restate the import instead of testing it
  // (16 expected minus 16 "missing products" = 0, which the empty table matches exactly). So the
  // expected side is resolved AGAINST THE JSON: an entry counts when the product or store it names
  // is really present in the files. A lookup that breaks then has nowhere to hide.
  const storeSlugs = new Set(stores.map((s) => String(s.slug)));
  const storeSlugById = new Map(stores.map((s) => [s.id, String(s.slug)]));
  const productKeys = new Set(products
    .filter((p) => storeSlugById.has(p.storeId))
    .map((p) => `${storeSlugById.get(p.storeId)}/${p.slug}`));

  const liveWishlist = Object.values(carts).reduce((n, d) => n
    + (d.wishlist ?? []).filter((w) => productKeys.has(`${w.storeSlug}/${w.slug}`)).length, 0);
  check('wishlist items (live products)', liveWishlist,
    await scalar(db, 'SELECT COUNT(*) FROM wishlist_items'), '§7.15');
  const liveFavorites = Object.values(carts).reduce((n, d) => n
    + (d.favoriteStores ?? []).filter((slug) => storeSlugs.has(slug)).length, 0);
  check('favourite stores (live stores)', liveFavorites,
    await scalar(db, 'SELECT COUNT(*) FROM favorite_stores'), '§7.15');
  check('recent stores', Object.values(carts).reduce((n, d) => n + (d.recentStores?.length ?? 0), 0),
    await scalar(db, 'SELECT COUNT(*) FROM recent_stores'));

  return checks;
}

/**
 * Human-readable report. Returns true when everything passed.
 * @param {Check[]} checks
 * @param {(line: string) => void} [log]
 */
export function reportChecks(checks, log = console.log) {
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    const mark = c.ok ? '  ok  ' : ' FAIL ';
    const detail = c.ok ? `${c.actual}` : `expected ${c.expected}, got ${c.actual}`;
    log(`${mark} ${c.name.padEnd(38)} ${detail}${c.note ? `   (${c.note})` : ''}`);
  }
  log(failed.length ? `\n${failed.length} of ${checks.length} checks FAILED.` : `\nAll ${checks.length} checks passed.`);
  return failed.length === 0;
}
