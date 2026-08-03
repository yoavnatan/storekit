/**
 * The catalog — the fourth module moved off `data/*.json` (DB_MIGRATION_PLAN.md §8 stage 2).
 *
 * Every reader and writer here is a query now, so all of them are `async` and every caller
 * `await`s (§3). The types and the answers are unchanged; what moved is where they come from,
 * plus the things a JSON file could not do:
 *
 *   · **`lib/mutex.ts` is dead here (§7.5).** Stock is decremented by one conditional `UPDATE`
 *     whose affected-row count IS the verdict — 1 means sold, 0 means there was not enough — and
 *     that holds across any number of server processes. The mutex only ever serialised one Node
 *     process, so two instances meant two mutexes and an oversell nothing would report.
 *   · **A product's slug is unique per store because an index says so, not because a scan said so
 *     first (§7.1/§7.4).** `UNIQUE (store_id, slug)`, with the same bump-and-retry loop
 *     `createStore` uses; a global `UNIQUE(slug)` would have been wrong — 47 slugs repeat across
 *     stores in the real data and none repeats inside one.
 *   · **Prices are integer agorot (§7.7).** `price_agorot bigint` in the column, ILS numbers at
 *     this module's edge (`money.ts#toAgorot`/`fromAgorot`), so nothing else in the app changes
 *     shape yet — the unit flips application-wide with `orders`, once, not once per module.
 *   · **Images, per-combo stock and per-colour photos are rows, not JSON blobs** — which is what
 *     lets `product_images` carry a `cloudinary_public_id` beside the URL (§7.10) and what makes
 *     the atomic decrement above possible at all.
 *
 * **The one shape that needed a schema change (migration 0003).** `variantStock` is a PARTIAL map:
 * a combo with no entry sells from the shared `stock` pool. `variantSku` is a second partial map
 * over the same keys, and 0001 gave both one row per combo — so a combo carrying only a code had
 * to be stored with `stock = 0`, which reads as "sold out" rather than "no override". `stock` is
 * nullable now and NULL is what "no override" means, here and in the importer.
 */
import crypto from 'node:crypto';
import { comboKey, isFullyPerCombo } from './variant-combo.js';
import { toSlug } from './url-base.js';
import { fromAgorot, toAgorot } from './money.js';
import { MAX_DISCOUNT_PERCENT, MIN_DISCOUNT_PERCENT, type ProductDiscount } from './discounts.js';
import { normalizeHe } from './product-listing.js';
import { firstRow, isUuid, query, rows, withTransaction, type Queryable } from './db.js';
export { LOW_STOCK_THRESHOLD } from './variant-combo.js';

export interface ProductSpec {
  label: string;
  value: string;
}

export interface ProductVariant {
  name: string;
  options: string[];
}

export interface StoreProduct {
  id: string;
  storeId: string;
  slug: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  images?: string[];
  /** Points at a node in store-categories.ts's per-store tree — the leaf/level the seller assigned this product to. Matching a category also matches its descendants (see product-listing.ts). */
  categoryId?: string;
  tags?: string[];
  /** Seller-defined product code (SKU) — distinct from `id` (our internal UUID); optional, unique per store when set. */
  sku?: string;
  specs?: ProductSpec[];
  variants?: ProductVariant[];
  /** Optional per-combination stock override, keyed by variant-combo.ts#comboKey(). Combos with no entry fall back to `stock`. */
  variantStock?: Record<string, number>;
  /** Optional per-combination SKU (Stock Keeping Unit), keyed by variant-combo.ts#comboKey().
   *  A real store gives each purchasable combo (blue-L vs blue-S) its own code — that's literally
   *  what a SKU is. The product-level `sku` still names the product as a whole; per-combo entries
   *  take precedence in the feed (mpn). Set only via CSV bulk import today (item_group_id rows);
   *  the single-product editor preserves but doesn't yet edit them. Uniqueness enforced per store
   *  across BOTH `sku` and every `variantSku` value. */
  variantSku?: Record<string, string>;
  /** Optional image override per color-variant option value (e.g. "אדום" → one of `images`) — lets the storefront swap the main photo when that color is picked instead of showing a generic gallery. Keyed by the raw option value, not a comboKey — a color choice implies the photo regardless of other dimensions (size, etc). */
  variantImages?: Record<string, string>;
  /** Admin-only kill switch (see admin-moderation.ts) — same purpose as Store.blocked
   *  but scoped to a single listing when the rest of the store is fine. 404s on its own
   *  product page, excluded from its store's grid/search/checkout. */
  blocked?: boolean;
  /** Seller-controlled "off the shelf" switch — a product the seller has deliberately
   *  taken down (e.g. permanently/intentionally out of stock) without deleting it. Same
   *  storefront effect as `blocked` (hidden from grid/search/product page/checkout/feed/
   *  sitemap via isProductVisible) but seller-owned, reversible from the dashboard, and —
   *  unlike a stock shortage — excluded from the Products tab's stock-alert count so an
   *  intentional take-down never nags (CURRENT_TASK.md, סשן א׳). */
  hidden?: boolean;
  /** Seller-set markdown on this product — percent or ₪ off, optionally scheduled, with a
   *  seller-controlled storefront badge. `price` stays the ORIGINAL (it is what gets struck
   *  through); the price to display/charge is always `discounts.ts#resolvePrice`, never this
   *  field or `price` read directly. Absent = sold at full price. */
  discount?: ProductDiscount;
  /** Private seller-only note ("things that help me handle this product"). Never
   *  rendered on any public/storefront surface — dashboard/edit-form only, and never
   *  leaked through /api/store-product, the feed, or JSON-LD (CURRENT_TASK.md, seller
   *  dashboard item 2). Free text, length-capped on write. */
  sellerNote?: string;
  createdAt: string;
}

/**
 * One product row, plus its three child tables folded in by the same statement.
 *
 * Selected explicitly rather than `SELECT *`, so a column a later migration adds cannot silently
 * change what this module returns. The `date` columns come back through `to_char` on purpose: a
 * `date` parsed into a JS `Date` lands at local midnight and formatting it back can move the day
 * across a timezone boundary (§7.8) — a sale that starts tomorrow is stored as text and read as
 * the same text.
 */
const COLUMNS = `p.id, p.store_id, p.slug, p.name, p.description, p.price_agorot, p.stock, p.sku,
    p.category_id, p.hidden, p.blocked, p.tags, p.specs, p.variants, p.seller_note,
    p.discount_type, p.discount_percent, p.discount_amount_agorot, p.discount_show_badge,
    to_char(p.discount_starts_at, 'YYYY-MM-DD') AS discount_starts_at,
    to_char(p.discount_ends_at, 'YYYY-MM-DD') AS discount_ends_at,
    p.created_at,
    (SELECT array_agg(i.url ORDER BY i.position)
       FROM product_images i WHERE i.product_id = p.id) AS images,
    (SELECT jsonb_object_agg(v.combo_key, v.stock)
       FROM product_variant_stock v WHERE v.product_id = p.id AND v.stock IS NOT NULL) AS variant_stock,
    (SELECT jsonb_object_agg(v.combo_key, v.sku)
       FROM product_variant_stock v WHERE v.product_id = p.id AND v.sku IS NOT NULL) AS variant_sku,
    (SELECT jsonb_object_agg(m.option_value, m.url)
       FROM product_variant_images m WHERE m.product_id = p.id) AS variant_images`;

/**
 * §7.13: a table has no natural order, and `rankDefault` (product-listing.ts) ends on a
 * `createdAt` comparison whose ties fall back to the order the rows arrived in — which used to be
 * the file's, stable by accident. Newest-first with `id` breaking a same-instant tie is both
 * stable and exactly the order `store_products_visible_idx (store_id, created_at DESC, id)` is
 * built to hand back, so the storefront grid gets its page without a sort step.
 */
const ORDER = 'ORDER BY p.created_at DESC, p.id';

/** `isProductVisible` as a predicate the index can answer — see `store_products_visible_idx`. */
const VISIBLE = 'NOT p.hidden AND NOT p.blocked';

interface ProductRow {
  id: string;
  store_id: string;
  slug: string;
  name: string;
  description: string;
  price_agorot: number;
  stock: number;
  sku: string | null;
  category_id: string | null;
  hidden: boolean;
  blocked: boolean;
  tags: string[] | null;
  specs: ProductSpec[] | null;
  variants: ProductVariant[] | null;
  seller_note: string | null;
  discount_type: 'percent' | 'amount' | null;
  discount_percent: number | null;
  discount_amount_agorot: number | null;
  discount_show_badge: boolean;
  discount_starts_at: string | null;
  discount_ends_at: string | null;
  created_at: Date | string | null;
  images: string[] | null;
  variant_stock: Record<string, number> | null;
  variant_sku: Record<string, string> | null;
  variant_images: Record<string, string> | null;
}

function nonEmpty<T extends object>(value: T | null): T | undefined {
  return value && Object.keys(value).length ? value : undefined;
}

/** The stored discount, rebuilt in exactly the shape `discount-input.ts#normalizeProductDiscount`
 *  writes — same keys, same omissions. `record-rev.ts` hashes this object field by field, so a
 *  shape that differed from the form's would make every save look like an edit of the discount. */
function toDiscount(row: ProductRow): ProductDiscount | undefined {
  if (!row.discount_type) return undefined;
  const value = row.discount_type === 'percent'
    ? (row.discount_percent ?? 0)
    : fromAgorot(row.discount_amount_agorot ?? 0);
  if (!value) return undefined;
  const discount: ProductDiscount = { type: row.discount_type, value };
  if (row.discount_show_badge === false) discount.showBadge = false;
  if (row.discount_starts_at) discount.startsAt = row.discount_starts_at;
  if (row.discount_ends_at) discount.endsAt = row.discount_ends_at;
  return discount;
}

/**
 * Row → `StoreProduct`, in the exact shape the rest of the app reads today.
 *
 * **Absent, not `null` and not empty.** Optional fields are written only when they carry
 * something, because that is what `createProduct` has always stored (`...(tags?.length ? {tags} :
 * {})`) and what ~60 call sites are written against (`p.images?.[0]`, `p.tags ?? []`). It is also
 * what `record-rev.ts#normalize` already folds together, so an empty array and a missing key
 * cannot read as an edit either way.
 */
function toProduct(row: ProductRow): StoreProduct {
  const product: StoreProduct = {
    id: row.id,
    storeId: row.store_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    price: fromAgorot(row.price_agorot),
    stock: row.stock,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
  };
  if (row.images?.length) product.images = row.images;
  if (row.category_id) product.categoryId = row.category_id;
  if (row.tags?.length) product.tags = row.tags;
  if (row.sku) product.sku = row.sku;
  if (row.specs?.length) product.specs = row.specs;
  if (row.variants?.length) product.variants = row.variants;
  const variantStock = nonEmpty(row.variant_stock);
  if (variantStock) product.variantStock = variantStock;
  const variantSku = nonEmpty(row.variant_sku);
  if (variantSku) product.variantSku = variantSku;
  const variantImages = nonEmpty(row.variant_images);
  if (variantImages) product.variantImages = variantImages;
  if (row.blocked) product.blocked = true;
  if (row.hidden) product.hidden = true;
  const discount = toDiscount(row);
  if (discount) product.discount = discount;
  if (row.seller_note) product.sellerNote = row.seller_note;
  return product;
}

/** Statements run on the pool, or on the transaction a writer is already inside. */
function on(tx?: Queryable) {
  return {
    rows: <Row>(text: string, params: readonly unknown[]) =>
      (tx ? tx.query<Row>(text, params).then((r) => r.rows) : rows<Row>(text, params)),
    first: async <Row>(text: string, params: readonly unknown[]) =>
      (tx ? (await tx.query<Row>(text, params)).rows[0] : await firstRow<Row>(text, params)),
  };
}

async function selectProducts(where: string, params: readonly unknown[] = [], tx?: Queryable, tail = ''): Promise<StoreProduct[]> {
  return (await on(tx).rows<ProductRow>(`SELECT ${COLUMNS} FROM store_products p WHERE ${where} ${ORDER} ${tail}`, params))
    .map(toProduct);
}

async function selectProduct(where: string, params: readonly unknown[] = [], tx?: Queryable): Promise<StoreProduct | null> {
  const row = await on(tx).first<ProductRow>(`SELECT ${COLUMNS} FROM store_products p WHERE ${where} LIMIT 1`, params);
  return row ? toProduct(row) : null;
}

/**
 * A product's URL segment, derived from its name — the seller never types it.
 *
 * **Keeps letters in ANY script, not just a-z.** This is a Hebrew marketplace whose sellers are
 * not required to know English: under the old `[^a-z0-9-]` strip, "חולצה כחולה" produced the empty
 * string, so every Hebrew-named product in a store fell back to the same `product` base and was
 * disambiguated by a counter — `/store/product`, `/store/product-2`, `/store/product-3`. That threw
 * away the single strongest on-page keyword signal a product URL carries, on the site's primary
 * language, for the majority of the catalogue (SEO is the platform's #1 goal). Hebrew in a path is
 * ordinary and fully indexable — Google reads it as the word, and browsers percent-encode it on the
 * wire — but a URL that ESCAPES the path must encode it, so every machine-read emitter (sitemap,
 * product feed, canonical/og:url) goes through `productPathSegment` in url-base.ts.
 *
 * `\p{L}\p{N}` also drops what a path must never carry — `/`, `?`, `#`, `%`, `.`, control
 * characters and the invisible RTL/LTR marks a Hebrew paste brings along — since none of those are
 * a letter or a number. Existing products keep their stored slug (this runs at creation only), so
 * no indexed URL moves.
 *
 * The rule itself lives in `url-base.ts#toSlug` — shared with `stores.ts#normalizeSlug` since the
 * store URL accepts Hebrew too, and two copies of a slug rule is how the store half came to throw
 * Hebrew away while this half kept it.
 */
export function slugify(name: string): string {
  return toSlug(name);
}

interface CreateProductInput {
  name: string;
  description?: string;
  price: number;
  stock?: number;
  images?: string[];
  categoryId?: string;
  tags?: string[];
  sku?: string;
  specs?: ProductSpec[];
  discount?: ProductDiscount;
  sellerNote?: string;
  variants?: ProductVariant[];
  variantStock?: Record<string, number>;
  variantSku?: Record<string, string>;
  variantImages?: Record<string, string>;
}

/** Both money and stock are constrained non-negative in the schema, and a form that submits a
 *  negative used to store one rather than raise. Clamping here keeps that answer: a bad number is
 *  a bad number, not a 500 on a page that worked yesterday. */
const units = (n: unknown): number => Math.max(0, Math.round(Number(n) || 0));
const agorot = (n: unknown): number => Math.max(0, toAgorot(Number(n) || 0));

/** True if another product in this store already uses this exact sku (case-sensitive, as typed). */
export async function isSkuTaken(storeId: string, sku: string, excludeId?: string): Promise<boolean> {
  if (!isUuid(storeId) || !sku) return false;
  const row = await firstRow<{ id: string }>(
    `SELECT id FROM store_products
      WHERE store_id = $1 AND sku = $2 AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1`,
    [storeId, sku, excludeId && isUuid(excludeId) ? excludeId : null],
  );
  return Boolean(row);
}

/** How many `name-2`, `name-3`… a colliding slug is worth trying before falling back to randomness. */
const SLUG_BUMP_ATTEMPTS = 50;

/**
 * Write the three child tables for a product, replacing whatever they held.
 *
 * `variantStock` and `variantSku` share `product_variant_stock` (same key, one row), so they are
 * always written TOGETHER from the resolved pair — writing one alone would delete the other's
 * rows. A combo present only in the sku map gets `stock = NULL`: no override, sells from the
 * shared pool (migration 0003).
 */
async function writeChildren(
  tx: Queryable,
  productId: string,
  children: {
    images?: string[];
    variantStock?: Record<string, number>;
    variantSku?: Record<string, string>;
    variantImages?: Record<string, string>;
  },
): Promise<void> {
  if (children.images) {
    await tx.query('DELETE FROM product_images WHERE product_id = $1', [productId]);
    const urls = children.images.filter(Boolean);
    if (urls.length) {
      await tx.query(
        `INSERT INTO product_images (product_id, position, url)
         SELECT $1, pos - 1, url FROM unnest($2::text[]) WITH ORDINALITY AS v(url, pos)`,
        [productId, urls],
      );
    }
  }

  if (children.variantStock || children.variantSku) {
    const stock = children.variantStock ?? {};
    const sku = children.variantSku ?? {};
    const keys = [...new Set([...Object.keys(stock), ...Object.keys(sku)])];
    await tx.query('DELETE FROM product_variant_stock WHERE product_id = $1', [productId]);
    if (keys.length) {
      await tx.query(
        `INSERT INTO product_variant_stock (product_id, combo_key, stock, sku)
         SELECT $1, k, s, c FROM unnest($2::text[], $3::int[], $4::text[]) AS v(k, s, c)`,
        [
          productId,
          keys,
          keys.map((k) => (k in stock ? units(stock[k]) : null)),
          keys.map((k) => sku[k] ?? null),
        ],
      );
    }
  }

  if (children.variantImages) {
    await tx.query('DELETE FROM product_variant_images WHERE product_id = $1', [productId]);
    const entries = Object.entries(children.variantImages).filter(([, url]) => Boolean(url));
    if (entries.length) {
      await tx.query(
        `INSERT INTO product_variant_images (product_id, option_value, url)
         SELECT $1, o, u FROM unnest($2::text[], $3::text[]) AS v(o, u)`,
        [productId, entries.map(([option]) => option), entries.map(([, url]) => url)],
      );
    }
  }
}

/**
 * The six discount columns, in the order every INSERT/UPDATE below lists them.
 *
 * **An unusable value stores NO discount rather than raising.** The columns carry the bands as
 * CHECK constraints (`discount_percent BETWEEN 1 AND 95`, `discount_amount_agorot > 0`), so a
 * percent of 0 or 200 — which the file version stored as an inert record — would now be a 500 on
 * a form that worked yesterday. Every save path already runs
 * `discount-input.ts#normalizeProductDiscount`, which drops exactly these; this repeats its answer
 * for anything that reaches the module another way, and keeps "a discount exists" meaning "it
 * means something".
 */
function discountValues(discount: ProductDiscount | undefined): unknown[] {
  const none = [null, null, null, true, null, null];
  if (!discount) return none;
  const percent = discount.type === 'percent' ? Math.round(Number(discount.value) || 0) : null;
  const amount = discount.type === 'amount' ? agorot(discount.value) : null;
  if (percent !== null && (percent < MIN_DISCOUNT_PERCENT || percent > MAX_DISCOUNT_PERCENT)) return none;
  if (amount !== null && amount <= 0) return none;
  return [
    discount.type,
    percent,
    amount,
    discount.showBadge !== false,
    discount.startsAt ?? null,
    discount.endsAt ?? null,
  ];
}

/**
 * Add one product.
 *
 * **The slug is settled by the unique index, not by a scan that ran before it.** Two products
 * added in the same moment used to both find `חולצה` free and both take it; here the second
 * `INSERT` simply returns no row and the loop tries `חולצה-2`. Same shape as `createStore`, for
 * the same reason, including the random suffix that ends the loop no matter how contended.
 */
export async function createProduct(storeId: string, input: CreateProductInput): Promise<StoreProduct> {
  return withTransaction((tx) => createProductIn(tx, storeId, input));
}

/**
 * `createProduct`'s body, on a caller-supplied transaction — for `store-products-bulk.ts`, whose
 * whole CSV batch has to land or not land as one unit. A thousand rows through `createProduct`
 * would be a thousand transactions, and a file that failed on row 600 would leave 599 products
 * behind with no way to tell which import they came from.
 */
export async function createProductIn(tx: Queryable, storeId: string, input: CreateProductInput): Promise<StoreProduct> {
  const {
    name, description = '', price, stock = 0, images, categoryId, tags, sku, specs,
    discount, sellerNote, variants, variantStock, variantSku, variantImages,
  } = input;
  const base = slugify(name) || 'product';

  for (let attempt = 0; attempt <= SLUG_BUMP_ATTEMPTS + 1; attempt += 1) {
    const slug = attempt === 0 ? base
      : attempt <= SLUG_BUMP_ATTEMPTS ? `${base}-${attempt + 1}`
      : `${base}-${crypto.randomBytes(4).toString('hex')}`;
    const id = crypto.randomUUID();
    const { rows: created } = await tx.query<{ id: string }>(
      `INSERT INTO store_products (
         id, store_id, slug, name, description, price_agorot, stock, sku, category_id,
         tags, specs, variants, seller_note,
         discount_type, discount_percent, discount_amount_agorot, discount_show_badge,
         discount_starts_at, discount_ends_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid,
               $10::text[], $11::jsonb, $12::jsonb, $13,
               $14, $15, $16, $17, $18::date, $19::date, now())
       ON CONFLICT (store_id, slug) DO NOTHING
       RETURNING id`,
      [
        id, storeId, slug, name, description, agorot(price), units(stock), sku || null,
        categoryId && isUuid(categoryId) ? categoryId : null,
        tags?.length ? tags : [],
        JSON.stringify(specs ?? []),
        JSON.stringify(variants ?? []),
        sellerNote || null,
        ...discountValues(discount),
      ],
    );
    if (!created[0]) continue;

    await writeChildren(tx, id, {
      images: images ?? [],
      variantStock: variantStock ?? {},
      variantSku: variantSku ?? {},
      variantImages: variantImages ?? {},
    });
    const product = await selectProduct('p.id = $1', [id], tx);
    if (product) return product;
  }
  // Unreachable in practice — the last attempt carries 32 bits of randomness. Throwing beats
  // returning a product the caller would then have to null-check for the first time.
  throw new Error(`Could not find a free slug for "${name}"`);
}

export async function getProductsByStoreId(storeId: string): Promise<StoreProduct[]> {
  if (!isUuid(storeId)) return [];
  return selectProducts('p.store_id = $1', [storeId]);
}

/** The same read on a caller-supplied transaction — the CSV batch resolves every row against the
 *  catalog it is about to rewrite, and reading it outside the transaction would mean judging one
 *  snapshot and writing over another. */
export async function getProductsByStoreIdIn(tx: Queryable, storeId: string): Promise<StoreProduct[]> {
  if (!isUuid(storeId)) return [];
  return selectProducts('p.store_id = $1', [storeId], tx);
}

/**
 * How many products a store holds, on the three populations anything asks about.
 *
 * **This is what replaced `getAllProducts()` for every counting caller (§3, 2026-08-03.)** The
 * admin dashboard used to read the WHOLE catalogue to render numbers: the Stores tab wanted a
 * count per row, the Attention tab wanted "is it zero", and the Advertising tab wanted the size of
 * the feed. Three counts over one `GROUP BY` answer all of them in a single round trip, and none
 * of them grows with the size of the catalogue.
 *
 * `storeIds` narrows it; omitted, it counts every store. Every requested id gets an entry (zeroed
 * when the store has nothing), so a caller never has to tell "no products" from "not asked".
 */
export interface StoreProductCounts {
  /** Every row, whatever its flags — what the admin roster calls "products". */
  total: number;
  /** `isProductVisible`: not seller-hidden, not admin-blocked. What a shopper can reach. */
  visible: number;
  /** Not admin-blocked. The product feed's population — a seller-hidden product is still
   *  exported, which is why this is its own number and not `visible`. */
  unblocked: number;
}

const ZERO_COUNTS: StoreProductCounts = { total: 0, visible: 0, unblocked: 0 };

export async function getProductCountsByStore(storeIds?: readonly string[]): Promise<Map<string, StoreProductCounts>> {
  const ids = storeIds ? [...new Set(storeIds.filter(isUuid))] : null;
  const counts = new Map<string, StoreProductCounts>((ids ?? []).map((id) => [id, { ...ZERO_COUNTS }]));
  if (ids && ids.length === 0) return counts;
  const found = await rows<{ store_id: string; total: number; visible: number; unblocked: number }>(
    `SELECT store_id,
            COUNT(*)                                        AS total,
            COUNT(*) FILTER (WHERE NOT hidden AND NOT blocked) AS visible,
            COUNT(*) FILTER (WHERE NOT blocked)             AS unblocked
       FROM store_products
      WHERE $1::uuid[] IS NULL OR store_id = ANY($1::uuid[])
      GROUP BY store_id`,
    [ids],
  );
  // `COUNT` is `bigint` — a string from `pg`, a number from PGlite (DB_MIGRATION_PLAN.md §8).
  for (const row of found) {
    counts.set(row.store_id, {
      total: Number(row.total),
      visible: Number(row.visible),
      unblocked: Number(row.unblocked),
    });
  }
  return counts;
}

/** How many escaped LIKE patterns one search may carry. A query is a header search box, not a
 *  language: past this the extra words only narrow, and each one is another index probe. */
const MAX_SEARCH_WORDS = 6;

/** `%`, `_` and `\` are LIKE metacharacters. Un-escaped, a shopper typing `50%` would be asking
 *  for "50 followed by anything", which is a wrong answer rather than an error — and a query of
 *  `%` alone would match the entire catalogue. */
function likeContains(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The platform's product search — every word of `query` present in the product's normalised
 * name+tags, newest first, capped.
 *
 * **The matching rule is `product-listing.ts#matchesQueryWords`, and both halves of it moved.**
 * The normalisation is `store_products.search_text`, a stored generated column written by
 * `product_search_text()` (migration 0006) — a character-for-character port of `normalizeHe`,
 * pinned to it by `tests/product-search-normalize.test.ts`. The word-by-word AND is one
 * `LIKE` per word against that column, which the trigram index answers.
 *
 * This is the §3 caller that mattered most: `site-search.ts` read the entire catalogue into memory
 * on every keystroke of the header search box, filtered it in Node and kept eight rows.
 *
 * `storeIds` scopes the search to the stores the caller is willing to show (the shopper roster —
 * a hit in a paused or blocked store is a dead link), and is required: an unscoped platform search
 * would surface products whose store the caller already decided not to list.
 */
export async function searchVisibleProducts(
  query: string,
  storeIds: readonly string[],
  limit: number,
): Promise<StoreProduct[]> {
  const words = normalizeHe(query).split(' ').filter(Boolean).slice(0, MAX_SEARCH_WORDS);
  const ids = [...new Set(storeIds.filter(isUuid))];
  if (!words.length || !ids.length || limit <= 0) return [];
  // $1 = store ids, $2 = limit, $3.. = one pattern per word. Built as separate predicates rather
  // than `LIKE ALL(array)` on purpose: the planner only reaches the trigram index through a plain
  // `LIKE`, and the whole point of the column is that it is indexed.
  const wordParams = words.map((_, i) => `p.search_text LIKE $${i + 3} ESCAPE '\\'`).join(' AND ');
  return selectProducts(
    `p.store_id = ANY($1::uuid[]) AND ${VISIBLE} AND ${wordParams}`,
    [ids, limit, ...words.map(likeContains)],
    undefined,
    'LIMIT $2',
  );
}

/** false for an admin-blocked OR seller-hidden product. Every public discovery/purchase
 *  surface must gate through this — not repeat `!product.blocked` inline — so a future call
 *  site can't forget the check the way a few already did (found in review, 2026-07-14: the
 *  product page's own header-search suggestions and checkout.astro's shipping-total map both
 *  still leaked a blocked product before this consolidation). `hidden` is the seller's own
 *  reversible take-down (see the field doc); it rides the same gate so a hidden product is
 *  off every surface — grid, search, product page, checkout, feed, sitemap — exactly like a
 *  blocked one, with no new call sites to keep in sync.
 *
 *  Stays a pure predicate over an already-fetched record even though the same rule is now also
 *  SQL (`VISIBLE` above): callers filter lists they hold in memory with it, and the two are
 *  pinned to each other by `tests/product-visibility-guard.test.ts`. */
export function isProductVisible(product: StoreProduct): boolean {
  return !product.blocked && !product.hidden;
}

/** getProductsByStoreId(), pre-filtered to non-blocked — the version every public listing
 *  (store grid, related products, search, "load more") should call instead of
 *  getProductsByStoreId() + an inline filter. */
export async function getVisibleProductsByStoreId(storeId: string): Promise<StoreProduct[]> {
  if (!isUuid(storeId)) return [];
  return selectProducts(`p.store_id = $1 AND ${VISIBLE}`, [storeId]);
}

/**
 * The same thing for MANY stores, in one query, grouped by store id.
 *
 * The homepage, `/stores` and the sitemap each hold a list of stores and need every one's shelf.
 * Per-store that is N queries fired at once — with a pool of ten and a five-second checkout
 * timeout, a mall of a few hundred stores turns its own front page into a connection stampede,
 * which is precisely the "works in dev, falls over in production" shape §7.16 exists to prevent.
 * (As file reads it was N parses of the WHOLE catalog, so this is not a regression being fixed —
 * it is the thing the move made fixable.)
 *
 * Every requested id gets an entry, empty if the store has nothing on its shelves, so a caller
 * never has to distinguish "no products" from "store not asked about".
 */
/** productId → name, for a known set of ids. The admin Data tab labels eight analytics rows and
 *  read the whole catalogue to do it (§3); an id with no row (a product since deleted, which
 *  `analytics_products` deliberately keeps — §4) simply has no entry. */
export async function getProductNames(productIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(productIds.filter(isUuid))];
  if (!ids.length) return new Map();
  const found = await rows<{ id: string; name: string }>(
    'SELECT id, name FROM store_products WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return new Map(found.map((r) => [r.id, r.name]));
}

/** The same batch WITHOUT the visibility filter — the admin sellers tab, which renders a
 *  per-product block toggle and therefore has to see the products that are already blocked or
 *  hidden. Scoped to the ids on the page being rendered, never the whole catalogue (§3). */
export async function getProductsByStoreIds(storeIds: readonly string[]): Promise<Map<string, StoreProduct[]>> {
  const ids = [...new Set(storeIds.filter(isUuid))];
  const byStore = new Map<string, StoreProduct[]>(ids.map((id) => [id, []]));
  // No ids means no statement — an empty `ANY(…)` is a query for nothing.
  const products = ids.length ? await selectProducts('p.store_id = ANY($1::uuid[])', [ids]) : [];
  for (const product of products) byStore.get(product.storeId)?.push(product);
  return byStore;
}

export async function getVisibleProductsByStoreIds(storeIds: readonly string[]): Promise<Map<string, StoreProduct[]>> {
  const ids = [...new Set(storeIds.filter(isUuid))];
  const byStore = new Map<string, StoreProduct[]>(ids.map((id) => [id, []]));
  // One ORDER BY over the whole result, so each store's slice keeps the order a single-store
  // read would have given it. No ids means no statement — an empty `ANY(…)` is a query for nothing.
  const products = ids.length ? await selectProducts(`p.store_id = ANY($1::uuid[]) AND ${VISIBLE}`, [ids]) : [];
  for (const product of products) byStore.get(product.storeId)?.push(product);
  return byStore;
}

/** Just enough of a product to name it in a sitemap or a link list. */
export interface ProductRef {
  storeId: string;
  slug: string;
  createdAt: string;
}

/**
 * Every visible product of the given stores, as slug + date only.
 *
 * The sitemap walks the whole mall and writes two strings per product — a URL and a `lastmod`. It
 * was reading the full catalogue to do it: descriptions, tags, specs, variant definitions, and the
 * aggregated image / variant-stock / variant-sku arrays, all fetched, shipped and dropped. That is
 * the same waste the homepage had, on the one route Google fetches on its own schedule.
 *
 * Grouped by store because the caller needs a per-store count too (a store with nothing visible is
 * an empty shell and stays out of the sitemap entirely — `store-readiness.ts`). Same ORDER as the
 * full reader, so the file's entries keep the order they had.
 */
export async function getVisibleProductRefsByStoreIds(storeIds: readonly string[]): Promise<Map<string, ProductRef[]>> {
  const ids = [...new Set(storeIds.filter(isUuid))];
  const byStore = new Map<string, ProductRef[]>(ids.map((id) => [id, []]));
  const found = ids.length
    ? await rows<{ store_id: string; slug: string; created_at: Date | string }>(
        `SELECT p.store_id, p.slug, p.created_at
           FROM store_products p
          WHERE p.store_id = ANY($1::uuid[]) AND NOT p.hidden AND NOT p.blocked
          ORDER BY p.created_at DESC, p.id`,
        [ids],
      )
    : [];
  for (const row of found) {
    byStore.get(row.store_id)?.push({
      storeId: row.store_id,
      slug: row.slug,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    });
  }
  return byStore;
}

/** Thumbnails to fetch per store card. Four, not three: a sparse shelf widens its cards and a
 *  fourth thumb restores their proportion (HomeShelf.astro), so four is the most any card can
 *  draw. Fetching the maximum once beats asking the layout first. */
export const STORE_PREVIEW_SLOTS = 4;

/** What a store card needs from its catalogue, and nothing else. */
export interface StorePreview {
  /** Whether the store has ANY visible product. The homepage drops a store with none, and a store
   *  with products but no photos keeps its place and draws placeholder squares — so this is a
   *  separate fact from the images below, not `images.length > 0`. */
  hasProducts: boolean;
  /** First image of each of the first few visible products, newest first — exactly the thumbnails
   *  the card draws, in the order it would have drawn them. */
  images: string[];
}

/**
 * The homepage and `/stores` in one statement: does each store have anything to sell, and the
 * handful of thumbnails its card shows.
 *
 * **Why this exists — measured 2026-08-03, and it is the shopper's most important page.** Both
 * pages called `getVisibleProductsByStoreIds`, which reads every visible product of every visible
 * store *with every column*, including the aggregated image, variant-stock and variant-sku arrays.
 * They then used two things from it: whether the list was empty, and `products.map(p => p.images[0])`
 * capped at three or four per card. Everything else was fetched, shipped across the network, parsed
 * and dropped. Against Neon that measured **420ms for the products and 482ms for their images** —
 * about 900ms of a 778ms time-to-first-byte, for 930 products and 2,259 image rows, to draw roughly
 * 180 thumbnails. It was invisible as a JSON file read; over a network it is most of the page.
 *
 * `LIMIT` per store needs a window function rather than a plain `LIMIT`, which would cut the whole
 * result rather than each store's share. The ranking repeats `ORDER BY created_at DESC, id` because
 * that is what `getVisibleProductsByStoreIds` returns and therefore which products the card used to
 * show — a different order here would silently reshuffle every card on the homepage.
 *
 * Products with no photo are excluded from the ranking, not ranked and then filtered: the old code
 * mapped every product to its first image and dropped the blanks *before* slicing, so a store whose
 * three newest products have no photos still shows its next three that do.
 */
export async function getStorePreviews(storeIds: readonly string[], perStore: number): Promise<Map<string, StorePreview>> {
  const ids = [...new Set(storeIds.filter(isUuid))];
  const byStore = new Map<string, StorePreview>(ids.map((id) => [id, { hasProducts: false, images: [] }]));
  if (!ids.length) return byStore;

  const rows_ = await rows<{ store_id: string; images: string[] | null }>(
    `WITH visible AS (
       SELECT p.id, p.store_id, p.created_at,
              (SELECT i.url FROM product_images i WHERE i.product_id = p.id ORDER BY i.position LIMIT 1) AS image
         FROM store_products p
        WHERE p.store_id = ANY($1::uuid[]) AND NOT p.hidden AND NOT p.blocked
     ),
     ranked AS (
       SELECT store_id, image,
              row_number() OVER (PARTITION BY store_id ORDER BY created_at DESC, id) AS rn
         FROM visible
        WHERE image IS NOT NULL
     )
     SELECT v.store_id,
            (SELECT array_agg(r.image ORDER BY r.rn)
               FROM ranked r WHERE r.store_id = v.store_id AND r.rn <= $2) AS images
       FROM visible v
      GROUP BY v.store_id`,
    [ids, perStore],
  );

  // A row here means the store has at least one visible product; `images` is null when none of them
  // carries a photo, which is the placeholder case rather than an empty shelf.
  for (const row of rows_) byStore.set(row.store_id, { hasProducts: true, images: row.images ?? [] });
  return byStore;
}

/** A product with every seller-private field removed — what a public endpoint is allowed to
 *  serialize. `sellerNote` is explicitly dashboard-only (see its field doc), and returning a
 *  whole row verbatim is how it reaches a shopper by accident: /api/store-products (the store
 *  grid's "load more") did exactly that until this existed. Anything private added to
 *  StoreProduct later must be dropped here too. */
export function toPublicProduct(p: StoreProduct): Omit<StoreProduct, 'sellerNote'> {
  // eslint-disable-next-line sonarjs/no-unused-vars -- the binding exists only to omit the field
  const { sellerNote: _sellerNote, ...pub } = p;
  return pub;
}

export async function getProductById(id: string): Promise<StoreProduct | null> {
  if (!isUuid(id)) return null;
  return selectProduct('p.id = $1', [id]);
}

/** Case-sensitive on the slug's text, exactly as `getStoreBySlug` is: the column is `citext` so
 *  that one store cannot hold `Shirt` and `shirt` as two products, but serving the page at every
 *  capitalisation would put the same product on a dozen URLs pointing at one canonical. */
export async function getProductBySlug(storeId: string, slug: string): Promise<StoreProduct | null> {
  if (!isUuid(storeId) || !slug) return null;
  const wanted = slug.normalize('NFKC');
  return selectProduct('p.store_id = $1 AND p.slug = $2 AND p.slug::text = $3', [storeId, wanted, wanted]);
}

/** Count of a store's products that are actually on sale (not seller-hidden, not
 *  admin-blocked) yet out of / low on stock — the Products tab's stock-alert
 *  badge number. Single source of truth so the SSR badge and the value each
 *  mutating API returns to keep it live can never drift. `threshold` is
 *  variant-combo.ts#LOW_STOCK_THRESHOLD, passed in by callers so this data-layer
 *  module stays free of the variant helper dependency. */
/**
 * ✅ The bug this comment used to describe was FIXED with the `orders` migration (2026-08-02) —
 * kept here because the reasoning is what makes the query below trustworthy.
 *
 * The count reads `p.stock`, and `adjustStock`'s combo branch moves the BUCKET row, not `p.stock`.
 * So a product whose combos all carried their own bucket drained bucket by bucket while `p.stock`
 * stayed frozen at whatever the last save wrote, and this badge never lit for a product sold
 * combo-by-combo. (A partially-counted product was always fine: its uncounted combos sell from
 * `p.stock` through the `shared` branch, which does decrement it.)
 *
 * What made it a decision rather than a one-line fix: `p.stock` means TWO things — the shared pool
 * when any combo is uncounted, the total when none is — so "also decrement it" is right in one case
 * and steals from the pooled combos in the other. Two answers were on the table. Redefining
 * `p.stock` as pool-only, with sellable = `p.stock + SUM(buckets)`, is the tidier model and was
 * rejected as the bigger one: it changes what `stock` means to `isProductInStock`, the storefront,
 * JSON-LD and the Merchant feed's `availability`, and needs a data migration to stop every counted
 * product reading double. What shipped instead keeps both meanings and keeps the second one TRUE —
 * a sale out of a bucket re-derives `p.stock` from the buckets, exactly as a save already did
 * (`syncPooledStock`). No reader moved and no row needed migrating.
 */
export async function countStockAlerts(storeId: string, threshold: number): Promise<number> {
  if (!isUuid(storeId)) return 0;
  const row = await firstRow<{ count: number }>(
    `SELECT COUNT(*)::bigint AS count FROM store_products p
      WHERE p.store_id = $1 AND ${VISIBLE} AND p.stock <= $2`,
    [storeId, threshold],
  );
  return Number(row?.count ?? 0);
}

/**
 * The columns an update may touch, keyed by the field name a caller passes.
 *
 * **Built from `Object.keys(updates)`, never from the values** — the same rule `updateStore`
 * needed. Every save path here writes `sku: sku || undefined` / `discount` / `variantStock: … :
 * undefined`, meaning "clear it"; a loop that skipped undefined values would turn every clear into
 * a silent no-op, so a removed SKU or a cancelled sale would come back on the next page load.
 */
const UPDATABLE: Record<string, { sql: string; value: (v: unknown) => unknown }> = {
  name: { sql: 'name = $', value: (v) => String(v ?? '') },
  slug: { sql: 'slug = $', value: (v) => String(v ?? '') },
  description: { sql: 'description = $', value: (v) => String(v ?? '') },
  price: { sql: 'price_agorot = $', value: (v) => agorot(v) },
  stock: { sql: 'stock = $', value: (v) => units(v) },
  sku: { sql: 'sku = $', value: (v) => (v ? String(v) : null) },
  categoryId: { sql: 'category_id = $::uuid', value: (v) => (typeof v === 'string' && isUuid(v) ? v : null) },
  tags: { sql: 'tags = $::text[]', value: (v) => (Array.isArray(v) ? v : []) },
  specs: { sql: 'specs = $::jsonb', value: (v) => JSON.stringify(Array.isArray(v) ? v : []) },
  variants: { sql: 'variants = $::jsonb', value: (v) => JSON.stringify(Array.isArray(v) ? v : []) },
  sellerNote: { sql: 'seller_note = $', value: (v) => (v ? String(v) : null) },
  hidden: { sql: 'hidden = $', value: (v) => v === true },
  blocked: { sql: 'blocked = $', value: (v) => v === true },
};

type ProductUpdate = Partial<Omit<StoreProduct, 'id' | 'storeId' | 'createdAt'>>;

/**
 * Apply an edit.
 *
 * The whole thing is one transaction that starts by locking the product row (`FOR UPDATE`),
 * because the child tables are rewritten by DELETE + INSERT and `variantStock`/`variantSku` share
 * one of them: an edit that supplies only the stock map has to read the codes it is not touching,
 * and two dashboard tabs saving at once would otherwise interleave a read with the other's write.
 * The lock is also what serialises an inline stock edit against a checkout decrementing the same
 * row — the one case where the two writers genuinely collide.
 */
export async function updateProduct(id: string, updates: ProductUpdate): Promise<StoreProduct | null> {
  if (!isUuid(id)) return null;
  return withTransaction((tx) => updateProductIn(tx, id, updates));
}

/** `updateProduct`'s body on a caller-supplied transaction — same reason as `createProductIn`. */
export async function updateProductIn(tx: Queryable, id: string, updates: ProductUpdate): Promise<StoreProduct | null> {
  if (!isUuid(id)) return null;
  const { rows: locked } = await tx.query<{ id: string }>(
    'SELECT id FROM store_products WHERE id = $1 FOR UPDATE', [id],
  );
  if (!locked[0]) return null;

  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const key of Object.keys(updates)) {
    // `Object.hasOwn`, not a truthy lookup: `UPDATABLE['toString']` resolves to the inherited
    // Function.prototype method, which is truthy and has no `.sql` — a crash the moment a call
    // site passes a parsed request body instead of a literal.
    if (!Object.hasOwn(UPDATABLE, key)) continue;
    const spec = UPDATABLE[key]!;
    params.push(spec.value((updates as Record<string, unknown>)[key]));
    sets.push(spec.sql.replace('$', `$${params.length}`));
  }

  if ('discount' in updates) {
    const start = params.length + 1;
    params.push(...discountValues(updates.discount));
    sets.push(
      `discount_type = $${start}`,
      `discount_percent = $${start + 1}`,
      `discount_amount_agorot = $${start + 2}`,
      `discount_show_badge = $${start + 3}`,
      `discount_starts_at = $${start + 4}::date`,
      `discount_ends_at = $${start + 5}::date`,
    );
  }

  if (sets.length) {
    await tx.query(`UPDATE store_products SET ${sets.join(', ')} WHERE id = $1`, params);
  }

  // The two maps live in one table, so supplying either means writing both — the one that was
  // not supplied is read back from the row under the lock and written again unchanged.
  const touchesStock = 'variantStock' in updates;
  const touchesSku = 'variantSku' in updates;
  let variantStock = updates.variantStock ?? {};
  let variantSku = updates.variantSku ?? {};
  if (touchesStock !== touchesSku) {
    const current = await selectProduct('p.id = $1', [id], tx);
    if (!touchesStock) variantStock = current?.variantStock ?? {};
    if (!touchesSku) variantSku = current?.variantSku ?? {};
  }

  await writeChildren(tx, id, {
    ...('images' in updates ? { images: updates.images ?? [] } : {}),
    ...(touchesStock || touchesSku ? { variantStock, variantSku } : {}),
    ...('variantImages' in updates ? { variantImages: updates.variantImages ?? {} } : {}),
  });

  return selectProduct('p.id = $1', [id], tx);
}

/** Removes the product and, by `ON DELETE CASCADE`, its images, per-combo stock and per-colour
 *  photos. Orders keep their own snapshot of what was bought (§4) and are untouched. */
export async function deleteProduct(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await query('DELETE FROM store_products WHERE id = $1', [id]);
  return rowCount > 0;
}

/** Resolves which stock bucket a variant selection reads/writes: a per-combo `variantStock` entry if one exists, otherwise the shared `stock` pool (see `variantStock` doc comment above). */
function resolveStockField(product: StoreProduct, selectedVariants?: Record<string, string>): 'stock' | string {
  if (!product.variants?.length || !selectedVariants) return 'stock';
  const key = comboKey(selectedVariants);
  return product.variantStock && key in product.variantStock ? key : 'stock';
}

/** The stock number that actually governs this selection right now — same bucket `resolveStockField` would read or write. */
export function getEffectiveStock(product: StoreProduct, selectedVariants?: Record<string, string>): number {
  const field = resolveStockField(product, selectedVariants);
  return field === 'stock' ? product.stock : product.variantStock![field]!;
}

export interface StockAdjustResult {
  ok: boolean;
  /** The bucket's value immediately before this call, and after it (only meaningful when `ok`). On success both come from the statement that did the adjustment, so no separate read can slip between deciding and writing. On a REFUSAL both hold the bucket's current count, re-read after the refusal rather than taken from the statement's opening snapshot — see `stockAfterRefusal` for why those two differ under real concurrency. */
  before: number;
  after: number;
}

/**
 * Move one product's stock by `delta`, atomically, in whichever bucket the selection governs.
 *
 * **This single statement is what retires `lib/mutex.ts` (§7.5).** The mutex serialised a
 * read-modify-write inside ONE Node process; two processes meant two mutexes, two reads of the
 * same count and one unit sold twice, with nothing to report it. Here the precondition is part of
 * the write — `WHERE stock >= $qty` — so the number of rows affected IS the verdict, at any number
 * of instances, and there is no window between deciding and writing.
 *
 * The `target` CTE is what picks the bucket: a combo with its own override row (`stock IS NOT
 * NULL`) is decremented there, and anything else — a plain product, or a combo that never had an
 * override — comes out of the product's shared pool. Both branches are evaluated against the same
 * snapshot, exactly one of them can match, and `UNION ALL` returns whichever did.
 */
async function adjustStock(id: string, delta: number, selectedVariants: Record<string, string> | undefined): Promise<StockAdjustResult> {
  if (!isUuid(id)) return { ok: false, before: 0, after: 0 };
  const key = selectedVariants ? comboKey(selectedVariants) : null;

  return withTransaction(async (tx) => {
    const result = await adjustOneBucket(tx, id, delta, key);
    if (result.ok && result.branch === 'combo') await syncPooledStock(tx, id);
    return { ok: result.ok, before: result.before, after: result.after };
  });
}

/** The conditional UPDATE and its verdict — the part that must not change. */
async function adjustOneBucket(
  tx: Queryable, id: string, delta: number, key: string | null,
): Promise<StockAdjustResult & { branch: 'combo' | 'shared' | null }> {
  const [row] = (await tx.query<{ ok: boolean; before: number; after: number; branch: 'combo' | 'shared' | null }>(
    `WITH target AS (
       SELECT p.id, v.combo_key, COALESCE(v.stock, p.stock) AS stock
         FROM store_products p
         LEFT JOIN product_variant_stock v
           ON v.product_id = p.id AND v.combo_key = $2 AND v.stock IS NOT NULL
        WHERE p.id = $1
     ),
     combo AS (
       UPDATE product_variant_stock v SET stock = v.stock + $3
        WHERE v.product_id = $1
          AND v.combo_key = (SELECT combo_key FROM target)
          AND v.stock + $3 >= 0
       RETURNING v.stock - $3 AS before, v.stock AS after
     ),
     shared AS (
       UPDATE store_products p SET stock = p.stock + $3
        WHERE p.id = $1
          AND EXISTS (SELECT 1 FROM target WHERE combo_key IS NULL)
          AND p.stock + $3 >= 0
       RETURNING p.stock - $3 AS before, p.stock AS after
     )
     SELECT ok, before, after, branch FROM (
       SELECT true  AS ok, before, after, 'combo'::text  AS branch FROM combo
       UNION ALL
       SELECT true, before, after, 'shared'::text FROM shared
       UNION ALL
       SELECT false, stock, stock, NULL::text FROM target
     ) outcome
      ORDER BY ok DESC
      LIMIT 1`,
    [id, key, delta],
  )).rows;
  // No row at all means no such product.
  if (!row) return { ok: false, before: 0, after: 0, branch: null };
  if (row.ok) return { ok: true, before: row.before, after: row.after, branch: row.branch };
  return { ok: false, ...(await stockAfterRefusal(tx, id, key, row.before)), branch: null };
}

/**
 * The count to report when the adjustment was refused — and it needs its own statement, which was
 * MEASURED and is not what this code assumed (§9.5, 2026-08-03, 50 concurrent buyers of one unit
 * against the real server).
 *
 * `target` in the statement above is read from the snapshot taken when that statement STARTED. The
 * `UPDATE` beside it is not: blocked on the row lock a competing checkout already holds, it
 * re-reads the row once that lock is released and correctly refuses against the new value. So the
 * two disagree under contention, and the refusal carried the pre-contention count — measured, 7 of
 * 40 refusals reported up to 8 units left at an instant when the true stock was 0. Nothing was
 * oversold (the `UPDATE` is still the verdict), but that number is what the buyer's page clamps the
 * quantity selector to, so the shopper was offered stock that no longer existed and refused again
 * on the retry.
 *
 * A fresh statement inside the same transaction gets a fresh snapshot (READ COMMITTED), so this
 * sees every decrement committed so far. It costs one round-trip and it is paid ONLY on the
 * refusal path — the out-of-stock case, which is rare and already the slow one. The hot path stays
 * the single lock-free statement §7.5 is built on.
 */
async function stockAfterRefusal(
  tx: Queryable, id: string, key: string | null, fallback: number,
): Promise<{ before: number; after: number }> {
  const [row] = (await tx.query<{ stock: number }>(
    `SELECT COALESCE(v.stock, p.stock) AS stock
       FROM store_products p
       LEFT JOIN product_variant_stock v
         ON v.product_id = p.id AND v.combo_key = $2 AND v.stock IS NOT NULL
      WHERE p.id = $1`,
    [id, key],
  )).rows;
  const stock = row?.stock ?? fallback;
  return { before: stock, after: stock };
}

/**
 * Keep `p.stock` equal to the sum of the buckets, for a product whose combos are ALL counted.
 *
 * **This is the fix for the OPEN BUG above `countStockAlerts`, and it is deliberately the small
 * version of it.** `p.stock` means two things — the shared pool when any combo is uncounted, the
 * total when none is — and the file era kept the second meaning true only at SAVE time: the
 * product editor writes `sumComboOverrides(variantStock)` into the stock field, and then sales
 * drained the buckets while `p.stock` stayed frozen at whatever the last save wrote. So a product
 * sold combo-by-combo never lit its low-stock badge, and — the half the OPEN BUG note did not
 * reach — `product-feed.ts` reads the same frozen `p.stock` for `availability`, which means the
 * Merchant/Meta feed went on advertising a sold-out product as `in_stock`. That is an ads-account
 * problem, not a dashboard one.
 *
 * A SALE is now the same kind of event as a save, so the number the editor wrote stays true
 * between saves. Nothing else changes: `p.stock` still means what it meant, no reader moves, and
 * no stored row needs migrating — which is what separates this from redefining `p.stock` as
 * pool-only (that changes `isProductInStock`, the storefront, the feed and JSON-LD, and needs a
 * data migration to stop every counted product's stock reading double).
 *
 * **Recomputed from the buckets, not adjusted by the delta.** `SUM` over the authoritative rows is
 * idempotent and self-healing: a row that drifted in the file era is corrected by the first sale
 * after it, and two concurrent sales cannot both apply a delta and land on the wrong total. It runs
 * inside the caller's transaction, after the conditional UPDATE that already decided the sale, so
 * it can never turn a successful sale into a failed one.
 *
 * `isFullyPerCombo` is asked in JS rather than rebuilt in SQL on purpose. It is the same helper the
 * product editor and `/api/product` already use to decide the very thing this mirrors, and a second
 * copy of that rule written in SQL is how the two would come to disagree. The shape it reads (WHICH
 * combos carry a bucket) only changes when the seller edits the product, never when one sells — so
 * reading it a statement before the update is not the race it looks like. If a seller did edit the
 * dimensions mid-checkout, the worst case is `p.stock` being briefly stale, which their next save
 * corrects; the bucket, which is the actual inventory, is never wrong.
 */
async function syncPooledStock(tx: Queryable, id: string): Promise<void> {
  // Take the product row before summing its buckets.
  //
  // Without it this is exact in the common case and off by one under a true collision: the
  // `SET stock = (SELECT SUM(...))` subquery is evaluated against the statement's snapshot, and
  // `READ COMMITTED` re-checks only the WHERE after taking the row lock — so two sales committing
  // in the same instant could both compute the same pre-sale sum and the later write would lose
  // the earlier one's unit. The consequence is small (`p.stock` briefly one high; the BUCKET, which
  // is the real inventory and the thing an oversell would come from, is never wrong, and the next
  // sale re-derives the total correctly) — but "briefly wrong stock" is what this function was
  // written to stop, and the fix is one row lock on a row the statement below updates anyway.
  await tx.query('SELECT id FROM store_products WHERE id = $1 FOR UPDATE', [id]);

  const [shape] = (await tx.query<{ variants: ProductVariant[] | null; variant_stock: Record<string, number> | null }>(
    `SELECT p.variants,
            COALESCE(jsonb_object_agg(v.combo_key, v.stock)
                     FILTER (WHERE v.combo_key IS NOT NULL AND v.stock IS NOT NULL), '{}'::jsonb) AS variant_stock
       FROM store_products p
       LEFT JOIN product_variant_stock v ON v.product_id = p.id
      WHERE p.id = $1
      GROUP BY p.id, p.variants`,
    [id],
  )).rows;
  if (!shape?.variants?.length) return;
  if (!isFullyPerCombo(shape.variants, shape.variant_stock ?? {})) return;

  await tx.query(
    `UPDATE store_products p
        SET stock = COALESCE((SELECT SUM(v.stock)::int FROM product_variant_stock v
                               WHERE v.product_id = p.id AND v.stock IS NOT NULL), 0)
      WHERE p.id = $1`,
    [id],
  );
}

/** Atomically decrements stock (the matching variant-combo bucket, or the shared pool) by `qty`. `ok:false` — without writing — if that would go negative, so callers can reject the purchase instead of overselling. */
export function decrementStock(id: string, qty: number, selectedVariants?: Record<string, string>): Promise<StockAdjustResult> {
  return adjustStock(id, -qty, selectedVariants);
}

/** Reverses a decrementStock — used to roll back stock already deducted for other items in the same checkout when a later item turns out to be out of stock. */
export function restockProduct(id: string, qty: number, selectedVariants?: Record<string, string>): Promise<StockAdjustResult> {
  return adjustStock(id, qty, selectedVariants);
}
