// data/*.json → Postgres. The logic half of `npm run db:import` (DB_MIGRATION_PLAN.md §8, stage 1).
//
// Kept apart from the CLI so the same code can be driven by a test against an in-process Postgres
// — an import script that has never been executed against the real files is a guess, and this one
// is executed against all 19 of them on every `npm test` (tests/db-import.test.ts).
//
// Two properties matter more than speed:
//
//  · RE-RUNNABLE. Every insert is `ON CONFLICT DO NOTHING`/`DO UPDATE`, so a run that fails
//    halfway can be fixed and repeated without dropping the database. That is what makes the
//    normalisation below iterative instead of one-shot.
//  · IT COUNTS WHAT IT DROPS. A row whose foreign key no longer resolves (a page-view bucket for a
//    product that was deleted — measured: 98 of 147) is skipped, and the skip is REPORTED. A
//    partial import that says nothing is the failure mode this whole file exists to avoid (§7.15).
//
// §7.3 lives here too: fields added late in the JSON era are missing on older rows, and one field
// has two shapes in the same file (`store-pageviews` holds both `64` and `{total, visitors[]}`).
// Every reader below normalises rather than assumes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * ILS (a JS float, sometimes carrying a binary tail) → integer agorot. §7.7, and the ONE place the
 * conversion happens.
 *
 * The `Number.EPSILON` nudge is not decoration and not a style choice: it is the same rule
 * `src/lib/money.ts#roundMoney` applies, and the two must agree to the agora or the imported total
 * differs from the total the application has been showing. A price stored as 1.005 is really
 * 1.00499999999999989 in binary, which rounds DOWN without the nudge and UP with it —
 * `tests/db-import.test.ts` checks the two against every price and total in the real data.
 * (Restated here rather than imported because this script runs under plain node, which cannot load
 * a TypeScript module.)
 */
export function toAgorot(ils) {
  const n = Number(ils);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) : 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A daily bucket value is either a bare count (older rows) or `{ total, visitors[] }`. §7.3. */
function normalizeBucket(value) {
  if (typeof value === 'number') return { total: value, visitors: [] };
  if (value && typeof value === 'object') {
    return { total: Number(value.total) || 0, visitors: Array.isArray(value.visitors) ? value.visitors : [] };
  }
  return { total: 0, visitors: [] };
}

function readJson(dataDir, name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')); }
  catch { return fallback; }
}

/**
 * Multi-row INSERT in chunks.
 *
 * One statement per row would be ~3,000 network round trips against a hosted database. Chunked
 * multi-row inserts turn that into a few dozen. The chunk is bounded by Postgres's 65,535
 * bind-parameter limit, not by taste.
 */
async function insertMany(db, table, columns, rows, conflict = 'DO NOTHING') {
  if (!rows.length) return 0;
  // Postgres's hard ceiling is 65,535 bind parameters per statement, but that is not the number to
  // aim at: a statement that large is slow to plan, holds a lot of memory, and — measured here —
  // is enough to wedge a WASM Postgres's wire parser outright (62,746 visitor rows in one INSERT
  // left every subsequent query returning nothing, with no error raised). A thousand rows keeps
  // the round-trip count low without approaching any of those edges.
  const perChunk = Math.max(1, Math.min(1000, Math.floor(8000 / columns.length)));
  let written = 0;
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const params = [];
    const tuples = chunk.map((row) => {
      const slots = row.map((value) => { params.push(value); return `$${params.length}`; });
      return `(${slots.join(',')})`;
    });
    await db.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT ${conflict}`,
      params,
    );
    written += chunk.length;
  }
  return written;
}

/**
 * @typedef {{ what: string, reason: string, count: number }} SkippedRows
 * @typedef {{ counts: Record<string, number>, skipped: SkippedRows[] }} ImportReport
 */

/**
 * The key that pairs a store slug with a product slug -- the ONE definition, because a wishlist
 * entry names a product that way and a bare product slug is not unique across stores (§7.1).
 *
 * It exists as a function rather than a template literal at each site for a reason that already
 * cost a full import: the two sites were written separately, one with a NUL separator and one
 * with a space, so every lookup missed and all 16 wishlist rows landed as "product no longer
 * exists" -- with the row counts, the money totals and every other check still green. One
 * definition cannot drift from itself.
 *
 * NUL is the separator because `url-base.ts#toSlug` collapses whitespace into hyphens and can
 * never emit one, so the key is unambiguous. It is spelled `\u0000` and never typed directly: a
 * raw NUL byte makes this file non-text, which is what hid the drift from grep in the first place.
 */
function productKey(storeSlug, productSlug) {
  return `${storeSlug}\u0000${productSlug}`;
}

/**
 * Import everything. `db` needs only `query(sql, params) → { rows }`, which both `pg` and an
 * in-process Postgres satisfy.
 *
 * `counts` is rows written per table, `skipped` is every row that could not be, with the reason.
 * The caller prints both; `verify-import.mjs` checks them.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }} db
 * @param {{ dataDir?: string }} [options]
 * @returns {Promise<ImportReport>}
 */
export async function importAll(db, { dataDir = path.join(process.cwd(), 'data') } = {}) {
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {SkippedRows[]} */
  const skipped = [];
  const note = (table, n) => { if (n) counts[table] = (counts[table] ?? 0) + n; };
  const drop = (what, reason, n = 1) => { if (n) skipped.push({ what, reason, count: n }); };

  // ---- accounts -----------------------------------------------------------
  const sellers = readJson(dataDir, 'sellers.json', []);
  // A duplicate email would fail the UNIQUE constraint. citext makes the comparison
  // case-insensitive (§7.11), so "A@x.com" and "a@x.com" collide here even though the JSON kept
  // both — first one wins, the rest are reported rather than silently merged.
  const seenEmail = new Set();
  const sellerRows = [];
  for (const s of sellers) {
    const email = String(s.email ?? '').toLowerCase();
    if (!email || seenEmail.has(email)) { drop('seller', `duplicate or empty email: ${email || '(empty)'}`); continue; }
    seenEmail.add(email);
    sellerRows.push([s.id, s.name ?? '', s.email, s.passwordHash ?? '', s.googleId || null, s.tier ?? null, s.createdAt ?? null]);
  }
  note('sellers', await insertMany(db, 'sellers',
    ['id', 'name', 'email', 'password_hash', 'google_id', 'tier', 'created_at'], sellerRows));
  const sellerIds = new Set(sellerRows.map((r) => r[0]));

  // ---- stores -------------------------------------------------------------
  const stores = readJson(dataDir, 'stores.json', []);
  const storeRows = [];
  const prevSlugRows = [];
  for (const s of stores) {
    if (!sellerIds.has(s.sellerId)) { drop('store', `owner account missing: ${s.slug}`); continue; }
    storeRows.push([
      s.id, s.sellerId, s.slug, s.name ?? '', s.tagline ?? '', s.description ?? '',
      JSON.stringify(s.colors ?? {}), s.categories ?? [], JSON.stringify(s.shipping ?? {}),
      s.bannerImage || null, s.profileImage || null, s.sale ? JSON.stringify(s.sale) : null,
      s.address || null,
      // §7.12 — `false`, never null. An absent flag in JS is falsy; a NULL in SQL matches neither
      // `= true` nor `= false`, and the row quietly disappears from every filtered query.
      Boolean(s.addressVisible), s.hours ? JSON.stringify(s.hours) : null, Boolean(s.hoursVisible),
      Boolean(s.blocked), Boolean(s.demo), Number(s.promoWeight) || 0, s.bgColors ?? [],
      s.feedSync ? JSON.stringify(s.feedSync) : null, s.feedExportToken || null,
      s.customDomain?.hostname || null, s.customDomain?.status || null, s.customDomain?.addedAt || null,
      s.pausedAt || null, s.closePendingAt || null, s.closedAt || null, s.createdAt ?? null,
    ]);
    for (const slug of s.previousSlugs ?? []) prevSlugRows.push([slug, s.id]);
  }
  note('stores', await insertMany(db, 'stores', [
    'id', 'seller_id', 'slug', 'name', 'tagline', 'description', 'colors', 'categories', 'shipping',
    'banner_image', 'profile_image', 'sale', 'address', 'address_visible', 'hours', 'hours_visible',
    'blocked', 'demo', 'promo_weight', 'bg_colors', 'feed_sync', 'feed_export_token',
    'custom_domain_hostname', 'custom_domain_status', 'custom_domain_added_at',
    'paused_at', 'close_pending_at', 'closed_at', 'created_at',
  ], storeRows));
  note('store_previous_slugs', await insertMany(db, 'store_previous_slugs', ['slug', 'store_id'], prevSlugRows));

  const storeIds = new Set(storeRows.map((r) => r[0]));
  const storeIdBySlug = new Map(storeRows.map((r) => [String(r[2]), r[0]]));

  // ---- categories ---------------------------------------------------------
  // Inserted parent-less first, then linked, so no ordering assumption about the file is needed:
  // a child that appears before its parent would otherwise fail the self-referencing key.
  const categories = readJson(dataDir, 'store-categories.json', []).filter((c) => {
    if (storeIds.has(c.storeId)) return true;
    drop('category', `store missing: ${c.name}`); return false;
  });
  note('store_categories', await insertMany(db, 'store_categories',
    ['id', 'store_id', 'name', 'position', 'created_at'],
    categories.map((c) => [c.id, c.storeId, c.name ?? '', Number(c.order) || 0, c.createdAt ?? null])));
  const categoryIds = new Set(categories.map((c) => c.id));
  for (const c of categories) {
    if (c.parentId && categoryIds.has(c.parentId)) {
      await db.query('UPDATE store_categories SET parent_id = $2 WHERE id = $1', [c.id, c.parentId]);
    }
  }

  // ---- products -----------------------------------------------------------
  const products = readJson(dataDir, 'store-products.json', []);
  const productRows = [];
  const imageRows = [];
  const variantStockRows = [];
  const variantImageRows = [];
  for (const p of products) {
    if (!storeIds.has(p.storeId)) { drop('product', `store missing: ${p.slug}`); continue; }
    const d = p.discount;
    productRows.push([
      p.id, p.storeId, p.slug, p.name ?? '', p.description ?? '',
      toAgorot(p.price), Math.max(0, Number(p.stock) || 0), p.sku || null,
      p.categoryId && categoryIds.has(p.categoryId) ? p.categoryId : null,
      Boolean(p.hidden), Boolean(p.blocked), p.tags ?? [],
      JSON.stringify(p.specs ?? []), JSON.stringify(p.variants ?? []), p.sellerNote || null,
      d?.type ?? null,
      d?.type === 'percent' ? Math.round(Number(d.value)) : null,
      d?.type === 'amount' ? toAgorot(d.value) : null,
      d ? d.showBadge !== false : true,
      d?.startsAt || null, d?.endsAt || null,
      p.createdAt ?? null,
    ]);
    (p.images ?? []).forEach((url, i) => { if (url) imageRows.push([p.id, i, url]); });
    for (const [combo, stock] of Object.entries(p.variantStock ?? {})) {
      variantStockRows.push([p.id, combo, Math.max(0, Number(stock) || 0), p.variantSku?.[combo] ?? null]);
    }
    // A per-combo SKU with no stock entry still needs its row, or the code is silently lost.
    for (const [combo, sku] of Object.entries(p.variantSku ?? {})) {
      if (!(combo in (p.variantStock ?? {}))) variantStockRows.push([p.id, combo, 0, sku]);
    }
    for (const [option, url] of Object.entries(p.variantImages ?? {})) {
      if (url) variantImageRows.push([p.id, option, url]);
    }
  }
  note('store_products', await insertMany(db, 'store_products', [
    'id', 'store_id', 'slug', 'name', 'description', 'price_agorot', 'stock', 'sku', 'category_id',
    'hidden', 'blocked', 'tags', 'specs', 'variants', 'seller_note',
    'discount_type', 'discount_percent', 'discount_amount_agorot', 'discount_show_badge',
    'discount_starts_at', 'discount_ends_at', 'created_at',
  ], productRows));
  note('product_images', await insertMany(db, 'product_images', ['product_id', 'position', 'url'], imageRows));
  note('product_variant_stock', await insertMany(db, 'product_variant_stock',
    ['product_id', 'combo_key', 'stock', 'sku'], variantStockRows));
  note('product_variant_images', await insertMany(db, 'product_variant_images',
    ['product_id', 'option_value', 'url'], variantImageRows));
  const productIds = new Set(productRows.map((r) => r[0]));
  // store slug + product slug -> product id. A product slug is NOT unique on its own (section 7.1
  // measured 47 repeats across stores), so the store has to be part of the key -- this is what
  // resolves a wishlist entry, which stores exactly that pair.
  const slugByStoreId = new Map(storeRows.map((r) => [r[0], String(r[2])]));
  const productIdBySlug = new Map();
  for (const r of productRows) {
    const storeSlug = slugByStoreId.get(r[1]);
    if (storeSlug) productIdBySlug.set(productKey(storeSlug, r[2]), r[0]);
  }

  // ---- orders -------------------------------------------------------------
  const orders = readJson(dataDir, 'orders.json', []);
  const orderRows = [];
  const itemRows = [];
  const orderStoreRows = [];
  let itemSeq = 0;
  for (const o of orders) {
    orderRows.push([
      o.id, o.checkoutRef || null, o.buyerId && sellerIds.has(o.buyerId) ? o.buyerId : null,
      o.buyerName ?? '', o.buyerEmail ?? '', o.buyerPhone ?? '',
      o.buyerAddress?.city ?? '', o.buyerAddress?.street ?? '', o.buyerAddress?.zip || null,
      toAgorot(o.shippingAmount), toAgorot(o.totalAmount),
      o.paymentRef || null, o.paymentStatus ?? 'pending', o.shippingStatus ?? 'pending',
      o.trackingNumber || null, o.createdAt ?? null, o.updatedAt ?? o.createdAt ?? null,
    ]);
    for (const it of o.items ?? []) {
      // Order lines have no id in the JSON (they were an array). A deterministic id derived from
      // the order keeps the import re-runnable: a second run produces the same ids and conflicts
      // instead of duplicating every line.
      itemRows.push([
        deterministicUuid(`${o.id}:${itemSeq++}`), o.id,
        isUuid(it.productId) ? it.productId : null,
        it.productName ?? '', it.productSlug ?? '', it.storeSlug ?? '', it.storeName ?? '',
        toAgorot(it.price), Math.max(1, Number(it.qty) || 1), it.image || null,
        it.selectedVariants ? JSON.stringify(it.selectedVariants) : null,
      ]);
    }
    for (const [slug, sub] of Object.entries(o.storeSubtotals ?? {})) {
      const notes = o.sellerNotes?.[slug];
      orderStoreRows.push([
        o.id, slug, sub.storeName ?? '', toAgorot(sub.subtotal), toAgorot(sub.shipping),
        sub.deliveryMethod || null,
        sub.discount?.type ?? null,
        sub.discount?.type === 'percent' ? Math.round(Number(sub.discount.value)) : null,
        sub.discount?.type === 'amount' ? toAgorot(sub.discount.value) : null,
        toAgorot(sub.discount?.applied ?? 0),
        // Legacy rows hold a single string where the current shape is a list.
        Array.isArray(notes) ? notes : notes ? [notes] : [],
      ]);
    }
  }
  note('orders', await insertMany(db, 'orders', [
    'id', 'checkout_ref', 'buyer_id', 'buyer_name', 'buyer_email', 'buyer_phone',
    'buyer_city', 'buyer_street', 'buyer_zip', 'shipping_agorot', 'total_agorot',
    'payment_ref', 'payment_status', 'shipping_status', 'tracking_number', 'created_at', 'updated_at',
  ], orderRows));
  note('order_items', await insertMany(db, 'order_items', [
    'id', 'order_id', 'product_id', 'product_name', 'product_slug', 'store_slug', 'store_name',
    'price_agorot', 'qty', 'image', 'selected_variants',
  ], itemRows));
  note('order_stores', await insertMany(db, 'order_stores', [
    'order_id', 'store_slug', 'store_name', 'subtotal_agorot', 'shipping_agorot', 'delivery_method',
    'discount_type', 'discount_percent', 'discount_amount_agorot', 'discount_applied_agorot', 'seller_notes',
  ], orderStoreRows));

  // ---- money journal + checkout keys ---------------------------------------
  note('money_events', await insertMany(db, 'money_events', [
    'id', 'at', 'type', 'order_id', 'checkout_ref', 'store_slug', 'amount_agorot',
    'from_value', 'to_value', 'actor', 'detail',
  ], readJson(dataDir, 'money-events.json', []).map((e) => [
    e.id, e.at ?? null, e.type, e.orderId || null, e.checkoutRef || null, e.storeSlug || null,
    e.amount === undefined ? null : toAgorot(e.amount),
    e.from ?? null, e.to ?? null, e.actor ?? 'system', e.detail ?? null,
  ])));

  note('checkout_idempotency', await insertMany(db, 'checkout_idempotency',
    ['key', 'status', 'owner', 'checkout_ref', 'order_ids', 'at'],
    readJson(dataDir, 'checkout-idempotency.json', []).map((r) => [
      r.key, r.status ?? 'pending', r.owner ?? null, r.checkoutRef ?? null, r.orderIds ?? [], r.at ?? null,
    ])));

  // ---- messaging ----------------------------------------------------------
  note('messages', await insertMany(db, 'messages', [
    'id', 'from_user_id', 'from_name', 'from_email', 'to_store_id', 'to_seller_id', 'to_store_name',
    'subject', 'content', 'product_ref', 'reply_to_id', 'read_by_seller', 'read_by_buyer', 'created_at',
  ], readJson(dataDir, 'messages.json', []).map((m) => [
    m.id, m.fromUserId ?? '', m.fromName ?? '', m.fromEmail ?? '',
    storeIds.has(m.toStoreId) ? m.toStoreId : null,
    sellerIds.has(m.toSellerId) ? m.toSellerId : null,
    m.toStoreName ?? '', m.subject ?? '', m.content ?? '',
    m.productRef ? JSON.stringify(m.productRef) : null,
    isUuid(m.replyToId) ? m.replyToId : null,
    Boolean(m.readBySeller), Boolean(m.readByBuyer), m.createdAt ?? null,
  ])));

  const adminMessages = readJson(dataDir, 'admin-messages.json', []).filter((m) => {
    if (sellerIds.has(m.sellerId)) return true;
    drop('admin message', 'seller account missing'); return false;
  });
  note('admin_messages', await insertMany(db, 'admin_messages', [
    'id', 'seller_id', 'from_role', 'subject', 'content', 'reply_to_id',
    'read_by_admin', 'read_by_seller', 'created_at',
  ], adminMessages.map((m) => [
    m.id, m.sellerId, m.fromRole, m.subject ?? null, m.content ?? '',
    isUuid(m.replyToId) ? m.replyToId : null,
    Boolean(m.readByAdmin), Boolean(m.readBySeller), m.createdAt ?? null,
  ])));

  note('notifications', await insertMany(db, 'notifications', [
    'id', 'user_id', 'role', 'type', 'title', 'body', 'read', 'related_id',
    'store_slug', 'store_name', 'created_at',
  ], readJson(dataDir, 'notifications.json', []).map((n) => [
    n.id, n.userId, n.role, n.type, n.title ?? '', n.body ?? '', Boolean(n.read),
    n.relatedId ?? null, n.storeSlug ?? null, n.storeName ?? null, n.createdAt ?? null,
  ])));

  // ---- advertising --------------------------------------------------------
  const campaigns = readJson(dataDir, 'ad-campaigns.json', []).filter((c) => {
    if (storeIds.has(c.storeId)) return true;
    drop('ad campaign', 'store missing'); return false;
  });
  note('ad_campaigns', await insertMany(db, 'ad_campaigns', [
    'id', 'store_id', 'store_slug', 'scope', 'product_id', 'product_name', 'product_ids',
    'product_names', 'category_ids', 'category_names', 'platform', 'monthly_budget_agorot',
    'duration_days', 'audience_gender', 'audience_age', 'status', 'paused_at', 'paused_reason',
    'archived_at', 'created_at', 'updated_at',
  ], campaigns.map((c) => [
    c.id, c.storeId, c.storeSlug ?? '', c.scope ?? 'store', c.productId ?? null, c.productName ?? null,
    c.productIds ?? [], c.productNames ?? [], c.categoryIds ?? [], c.categoryNames ?? [],
    c.platform, toAgorot(c.monthlyBudget), c.durationDays ?? null,
    c.audience?.gender ?? null, c.audience?.age ?? null, c.status ?? 'paused',
    c.pausedAt ?? null, c.pausedReason ?? null, c.archivedAt ?? null,
    c.createdAt ?? null, c.updatedAt ?? c.createdAt ?? null,
  ])));

  note('brand_campaigns', await insertMany(db, 'brand_campaigns', [
    'id', 'objective', 'headline', 'body', 'image_url', 'destination_url', 'platform',
    'monthly_budget_agorot', 'duration_days', 'status', 'paused_at', 'created_at', 'updated_at',
  ], readJson(dataDir, 'brand-campaigns.json', []).map((c) => [
    c.id, c.objective, c.headline ?? '', c.body ?? '', c.imageUrl ?? null, c.destinationUrl ?? '',
    c.platform, toAgorot(c.monthlyBudget), c.durationDays ?? null, c.status ?? 'paused',
    c.pausedAt ?? null, c.createdAt ?? null, c.updatedAt ?? c.createdAt ?? null,
  ])));

  // ---- operations ---------------------------------------------------------
  note('error_log', await insertMany(db, 'error_log', [
    'id', 'source', 'route', 'message', 'stack', 'status_code', 'store_slug', 'store_name',
    'actor_role', 'actor_id', 'actor_label', 'resolution_hint', 'resolved', 'created_at',
  ], readJson(dataDir, 'error-log.json', []).map((e) => [
    e.id, e.source, e.route ?? null, e.message ?? '', e.stack ?? null,
    Number.isFinite(e.statusCode) ? e.statusCode : null,
    e.storeSlug ?? null, e.storeName ?? null, e.actorRole ?? null, e.actorId ?? null,
    e.actorLabel ?? null, e.resolutionHint ?? null, Boolean(e.resolved), e.createdAt ?? null,
  ])));

  const settings = [
    ['platform_ads', readJson(dataDir, 'platform-ads.json', {})],
    ['admin_tab_views', readJson(dataDir, 'admin-tab-views.json', {})],
  ].map(([key, value]) => [key, JSON.stringify(value)]);
  note('app_settings', await insertMany(db, 'app_settings', ['key', 'value'], settings,
    '(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()'));

  // ---- analytics buckets (§5) ---------------------------------------------
  const storeViews = readJson(dataDir, 'store-pageviews.json', {});
  const storeViewRows = [];
  const storeVisitorRows = [];
  for (const [slug, days] of Object.entries(storeViews)) {
    const storeId = storeIdBySlug.get(slug);
    if (!storeId) { drop('store page-views', `store missing: ${slug}`, Object.keys(days).length); continue; }
    for (const [day, raw] of Object.entries(days)) {
      if (!DAY_RE.test(day)) { drop('store page-views', `unparseable day key: ${day}`); continue; }
      const { total, visitors } = normalizeBucket(raw);
      storeViewRows.push([storeId, day, total]);
      for (const v of new Set(visitors)) storeVisitorRows.push([storeId, day, v]);
    }
  }
  // A COUNTER, unlike everything above it, so a re-run must REFRESH it rather than skip it. With
  // `DO NOTHING` a second import left every existing day at its first-run value while the file had
  // moved on — the JSON is the source of truth until stage 2 retires it, and a counter that is
  // quietly one run out of date is precisely the §7.15 failure this import is built to prevent.
  note('store_page_views', await insertMany(db, 'store_page_views', ['store_id', 'day', 'total'],
    storeViewRows, '(store_id, day) DO UPDATE SET total = EXCLUDED.total'));
  note('store_page_view_visitors', await insertMany(db, 'store_page_view_visitors',
    ['store_id', 'day', 'visitor_id'], storeVisitorRows));

  const productViews = readJson(dataDir, 'product-pageviews.json', {});
  const productViewRows = [];
  const productVisitorRows = [];
  for (const [productId, days] of Object.entries(productViews)) {
    // Measured: 98 of 147 keys name a product that has since been deleted. Their views are
    // dropped — and counted, so "the graph looks light" is never mistaken for a bad week (§7.15).
    if (!productIds.has(productId)) { drop('product page-views', 'product deleted', Object.keys(days).length); continue; }
    for (const [day, raw] of Object.entries(days)) {
      if (!DAY_RE.test(day)) { drop('product page-views', `unparseable day key: ${day}`); continue; }
      const { total, visitors } = normalizeBucket(raw);
      productViewRows.push([productId, day, total]);
      for (const v of new Set(visitors)) productVisitorRows.push([productId, day, v]);
    }
  }
  note('product_page_views', await insertMany(db, 'product_page_views', ['product_id', 'day', 'total'],
    productViewRows, '(product_id, day) DO UPDATE SET total = EXCLUDED.total'));
  note('product_page_view_visitors', await insertMany(db, 'product_page_view_visitors',
    ['product_id', 'day', 'visitor_id'], productVisitorRows));

  const analytics = readJson(dataDir, 'analytics-events.json', {});
  const dailyRows = [];
  const visitorRows = [];
  const productCountRows = [];
  for (const [day, events] of Object.entries(analytics)) {
    if (!DAY_RE.test(day)) { drop('analytics', `unparseable day key: ${day}`); continue; }
    for (const [event, bucket] of Object.entries(events ?? {})) {
      const b = bucket ?? {};
      dailyRows.push([day, event, Number(b.count) || 0]);
      for (const v of new Set(b.visitors ?? [])) visitorRows.push([day, event, v]);
      // Kept whatever the id looks like — see the column's own note. A tally of a deleted (or
      // pre-uuid) product is still history, and losing it would understate a past month.
      for (const [pid, n] of Object.entries(b.products ?? {})) {
        productCountRows.push([day, event, pid, Number(n) || 0]);
      }
    }
  }
  note('analytics_daily', await insertMany(db, 'analytics_daily', ['day', 'event', 'count'],
    dailyRows, '(day, event) DO UPDATE SET count = EXCLUDED.count'));
  note('analytics_visitors', await insertMany(db, 'analytics_visitors', ['day', 'event', 'visitor_id'], visitorRows));
  note('analytics_products', await insertMany(db, 'analytics_products',
    ['day', 'event', 'product_id', 'count'], productCountRows,
    '(day, event, product_id) DO UPDATE SET count = EXCLUDED.count'));

  // ---- buyer state --------------------------------------------------------
  const carts = readJson(dataDir, 'user-carts.json', {});
  const cartRows = [];
  const wishRows = [];
  const favRows = [];
  const recentRows = [];
  for (const [userId, data] of Object.entries(carts)) {
    for (const [storeSlug, storeCart] of Object.entries(data.cart ?? {})) {
      for (const [cartKey, item] of Object.entries(storeCart.items ?? {})) {
        cartRows.push([
          userId, storeSlug, cartKey, storeCart.storeName ?? '', item.slug ?? '', item.name ?? '',
          toAgorot(item.price), item.basePrice === undefined ? null : toAgorot(item.basePrice),
          item.image || null, Math.max(1, Number(item.qty) || 1),
          item.selectedVariants ? JSON.stringify(item.selectedVariants) : null,
        ]);
      }
    }
    for (const w of data.wishlist ?? []) {
      // The JSON wishlist names a product by slug + store. A bare slug is NOT unique across stores
      // (§7.1), which is exactly the defect the product_id key removes.
      const id = productIdBySlug.get(productKey(w.storeSlug, w.slug));
      if (!id) { drop('wishlist item', `product no longer exists: ${w.storeSlug}/${w.slug}`); continue; }
      wishRows.push([userId, id]);
    }
    for (const slug of data.favoriteStores ?? []) {
      const id = storeIdBySlug.get(slug);
      if (!id) { drop('favourite store', `store missing: ${slug}`); continue; }
      favRows.push([userId, id]);
    }
    (data.recentStores ?? []).forEach((slug, i) => recentRows.push([userId, slug, i]));
  }
  note('cart_items', await insertMany(db, 'cart_items', [
    'user_id', 'store_slug', 'cart_key', 'store_name', 'product_slug', 'product_name',
    'price_agorot', 'base_price_agorot', 'image', 'qty', 'selected_variants',
  ], cartRows));
  note('wishlist_items', await insertMany(db, 'wishlist_items', ['user_id', 'product_id'], wishRows));
  note('favorite_stores', await insertMany(db, 'favorite_stores', ['user_id', 'store_id'], favRows));
  note('recent_stores', await insertMany(db, 'recent_stores', ['user_id', 'store_slug', 'position'], recentRows));

  return { counts, skipped };
}

/**
 * A stable uuid from a string, so re-running the import produces the SAME order-line ids instead
 * of a second copy of every line. Order lines were a JSON array and never had ids of their own.
 *
 * Name-based like a UUID v5, with the version and variant bits set as the format requires so the
 * value is a legal uuid for the column and reproducible on any machine. SHA-256 rather than the
 * v5 spec's SHA-1: nothing here depends on matching another system's v5 output, and there is no
 * reason to introduce a weak digest for a name that is already unique before it is hashed.
 */
function deterministicUuid(seed) {
  const h = crypto.createHash('sha256').update(`storekit-order-item:${seed}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;   // version 5
  h[8] = (h[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
