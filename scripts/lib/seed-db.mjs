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

// ============================================================================
// THE PURGE GATE
// ============================================================================
//
// Everything below this comment exists because `purge` used to take a WHERE clause and run it.
// The safety then lived in the two seeders — each passed a predicate a real store cannot satisfy —
// which means the FUNCTION was safe only for as long as every caller happened to be. A third
// caller, or one careless edit to a constant in either seeder, deleted stores, their whole
// catalogue and (through `purgeOrdersOfStores`) their orders, with nothing in the way. That is
// acceptable while every row in the database is seeded; it stops being acceptable the day a real
// seller signs up, and this is the half hour that closes it before then.
//
// Two layers, and they are deliberately not derived from each other:
//
//  1. **A caller names a scope, it does not write one.** `purge(db, 'demo')`. An unknown name
//     throws. There is no parameter through which arbitrary SQL reaches a DELETE any more.
//  2. **A scope is checked to be a SUBSET of the disposable set before anything is deleted.**
//     `DISPOSABLE_*` below is the single definition of "a seeder made this row", and the scopes
//     are narrowings of it — `demo` takes the demo half, `showcase` the showcase half. Layer 1
//     alone would still be defeated by widening a scope constant; this layer counts the rows the
//     scope matches that the disposable predicate does not, and refuses at the first one.
//
// The identifiers themselves live here rather than in the seeders, so the seeders no longer own
// any part of the answer to "what may be deleted".

/** Every demo account's email ends in this. Real registration cannot produce it — the domain does
 *  not resolve and nothing accepts mail for it. */
export const DEMO_EMAIL_SUFFIX = '@demo.local';
/** The single platform-owned account the showcase stores hang off (`seed-showcase-stores.mjs`). */
export const SHOWCASE_OWNER_EMAIL = 'showcase@dezabin.co.il';



/**
 * These predicates are composed — a scope clause and the disposable clause meet inside one
 * statement — so a bind parameter is the wrong tool: the placeholder numbers of two independently
 * written fragments would have to agree, and a fragment that happens not to mention `$2` makes
 * Postgres reject the call outright ("bind message supplies 2 parameters, but prepared statement
 * requires 1"). The values here are module constants, never caller or request input, so they are
 * written into the SQL as literals. The escape is what makes that a rule rather than a habit.
 */
const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** An account a seeder created. Nothing else may ever be deleted by this file. */
const DISPOSABLE_SELLER = `(email LIKE '%' || ${lit(DEMO_EMAIL_SUFFIX)} OR email = ${lit(SHOWCASE_OWNER_EMAIL)})`;
/** A store a seeder created — either flagged as demo content, or owned by a disposable account. */
const DISPOSABLE_STORE = `(demo = true OR seller_id IN (SELECT id FROM sellers WHERE ${DISPOSABLE_SELLER}))`;

/**
 * The only two scopes that exist. Each is a NARROWING of the disposable predicates above: a run of
 * `seed:demo` must not remove the showcase stores and a run of `seed:showcase` must not remove the
 * demo ones, which is the whole reason there are two rather than one.
 */
export const SEED_SCOPES = {
  demo: {
    stores: `seller_id IN (SELECT id FROM sellers WHERE email LIKE '%' || ${lit(DEMO_EMAIL_SUFFIX)})`,
    sellers: `email LIKE '%' || ${lit(DEMO_EMAIL_SUFFIX)}`,
  },
  showcase: {
    stores: `demo = true OR seller_id IN (SELECT id FROM sellers WHERE email = ${lit(SHOWCASE_OWNER_EMAIL)})`,
    sellers: `email = ${lit(SHOWCASE_OWNER_EMAIL)}`,
  },
};

/** Layer 1. */
function scopeOf(name) {
  const scope = SEED_SCOPES[name];
  if (!scope) {
    throw new Error(`purge: unknown scope ${JSON.stringify(name)} — expected one of ${Object.keys(SEED_SCOPES).join(', ')}`);
  }
  return scope;
}

/**
 * Layer 2. Counts what the scope matches and the disposable predicate does not, and throws on the
 * first one rather than reporting afterwards — the whole point is that the DELETE has not run yet.
 */
async function assertSubsetOfDisposable(db, table, where, disposable) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE (${where}) AND NOT ${disposable}`);
  const n = Number(rows[0]?.n ?? 0);
  if (n > 0) {
    throw new Error(
      `purge refused: ${n} row(s) in "${table}" match this scope but are not seeded data. `
      + 'A scope may only ever narrow the disposable set (seed-db.mjs → THE PURGE GATE).',
    );
  }
}

/**
 * Remove whole stores and, optionally, the accounts that own them.
 *
 * Order matters and is enforced by the schema: `stores.seller_id` is `ON DELETE RESTRICT` (§7.9 —
 * an account with a store is not deleted out from under it), while everything hanging off a store
 * cascades. So the stores go first and take their categories, products, images, per-combo stock,
 * campaigns and analytics with them.
 *
 * @param {'demo'|'showcase'} scopeName
 * @param {{ includeSellers?: boolean }} [opts] `false` keeps the accounts — what a re-seed wants
 *   when it is about to reuse the same owner row rather than recreate it.
 */
export async function purge(db, scopeName, opts = {}) {
  const { includeSellers = true } = opts;
  const scope = scopeOf(scopeName);
  await assertSubsetOfDisposable(db, 'stores', scope.stores, DISPOSABLE_STORE);
  if (includeSellers) await assertSubsetOfDisposable(db, 'sellers', scope.sellers, DISPOSABLE_SELLER);

  const storeRes = await db.query(`DELETE FROM stores WHERE ${scope.stores}`);
  let sellers = 0;
  if (includeSellers) {
    const res = await db.query(`DELETE FROM sellers WHERE ${scope.sellers}`);
    sellers = res.rowCount ?? 0;
  }
  return { stores: storeRes.rowCount ?? 0, sellers };
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
 * **A shared order is kept, not deleted — this is where the old version was actually wrong, not
 * just unguarded.** One order can span several stores (`order_stores`, one row each), so a cart
 * holding a demo product and a real one produces a single order that "belongs to" a demo store by
 * the old predicate. Deleting it took a real seller's order and its money with it. The scope now
 * selects orders every one of whose stores is disposable; the rest are counted and reported, so a
 * leftover is visible rather than silent. A slug matching no store row at all (its store was
 * deleted) counts as NOT disposable — nothing is left to prove it was seeded, and the safe
 * direction under that doubt is to keep the order.
 *
 * Children first, because `order_items`/`order_stores` reference `orders` with `ON DELETE RESTRICT`
 * — the same rule that protects a real order from a careless cascade.
 *
 * **`money_events` goes with them, and leaving it behind was a real bug (owner, 2026-08-16: "יש שם
 * כרגע 48 אי-התאמות?!").** The journal names its order by TEXT with no foreign key, deliberately —
 * an event can be recorded before any order row exists, and a payment attempt that never became an
 * order still has to be recorded somewhere. So a purge that deleted orders and stopped there left
 * every event pointing at an order id nothing answers to. The measured state on the owner's machine:
 * 48 `refund_due` rows written by the fulfilment SLA job, all of them for orders a later
 * `seed:demo --clean` had removed. `reconcile.ts` reads an unsettled `refund_due` as money owed to a
 * real buyer — correctly — so the admin's integrity banner reported 48 debts totalling real shekels,
 * none of which existed.
 *
 * That is worse than untidy. `AdminReconciliationCard`'s whole design rests on the alarm being rare:
 * its clean state is one muted line precisely so the red state keeps its weight. An alarm that is
 * permanently on after any re-seed teaches the owner to skip the one place a real discrepancy will
 * appear — and the fix belongs HERE rather than in a filter over the journal, because a journal that
 * quietly hides rows is no longer a journal.
 *
 * Deleted by `order_id` AND by `checkout_ref`: the pre-order events (`payment_attempted`,
 * `duplicate_checkout_blocked`) carry only the ref, so an order-id sweep alone would strand exactly
 * the rows that describe a checkout that never became one.
 *
 * @param {'demo'|'showcase'} scopeName
 * @returns {Promise<{ deleted: number, keptShared: number, journalRows: number }>}
 */
/**
 * Remove the showcase stores' illustrative ratings.
 *
 * **One predicate, `demo = true`, and it is the whole purge gate.** Nothing else on the platform
 * sets that column — the API cannot (`createReview` has no path to it) and a real buyer's review is
 * refused by migration 0040's CHECK unless it carries an order. So there is no argument under which
 * this DELETE reaches a review somebody wrote.
 *
 * It lives HERE and not in the seeder because `tests/seed-purge-gate.test.ts` refuses a `DELETE`
 * written anywhere else under `scripts/`: a seeder NAMES what it is disposing of and never composes
 * its own `WHERE`. That guard caught this function's first draft sitting in the caller.
 *
 * No child rows to walk, which is the point of the change that produced this: a demo review has no
 * order, so there is nothing underneath it and nothing to delete in an order.
 */
/**
 * The mark every order `seed-returns.mjs` writes carries, in its `payment_ref`.
 *
 * A prefix rather than a flag column, and it earns that: `orders.payment_ref` is UNIQUE and is a
 * gateway's own reference, so nothing on the platform can write this string except the seeder — a
 * real charge's ref comes from a provider, and there is no provider connected. It is the whole purge
 * predicate below, exactly as `product_reviews.demo` is for the ratings.
 */
export const RETURN_DEMO_PAYMENT_REF = 'demo-returns-';

/**
 * Remove the staged return scenarios and the orders they were staged on.
 *
 * It lives here for the reason every purge does: `tests/seed-purge-gate.test.ts` refuses a `DELETE`
 * on an account, a store or an order written anywhere else under `scripts/` — a seeder NAMES what it
 * disposes of and never composes its own `WHERE`.
 *
 * Children first, `orders` last: `order_items`, `order_stores` and `return_requests` all reference
 * `orders` with `ON DELETE RESTRICT`. `money_events` names its order by TEXT with no foreign key, so
 * it would not block the delete — it is swept anyway, because a journal row pointing at an order that
 * is gone is what `reconcile.ts` reads as a real debt to a real buyer (see `purgeOrdersOfStores`,
 * which learned this from 48 phantom ones).
 *
 * @returns {Promise<{ orders: number, requests: number }>}
 */
export async function purgeReturnDemo(db) {
  const { rows } = await db.query(
    'SELECT id FROM orders WHERE payment_ref LIKE $1', [`${RETURN_DEMO_PAYMENT_REF}%`]);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return { orders: 0, requests: 0 };
  const requests = await db.query('DELETE FROM return_requests WHERE order_id = ANY($1::uuid[])', [ids]);
  await purgeOrderLedger(db, ids);
  await db.query('DELETE FROM money_events WHERE order_id = ANY($1::text[])', [ids]);
  await db.query('DELETE FROM order_items WHERE order_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM order_stores WHERE order_id = ANY($1::uuid[])', [ids]);
  const orders = await db.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [ids]);
  return { orders: orders.rowCount ?? 0, requests: requests.rowCount ?? 0 };
}

export async function purgeDemoReviews(db) {
  const gone = await db.query('DELETE FROM product_reviews WHERE demo');
  return gone.rowCount ?? 0;
}

/**
 * The two money tables that reference an order with `ON DELETE SET NULL` — and therefore SURVIVE it.
 *
 * **A foreign key that does not block a delete is not the same as one that does not matter.**
 * `seller_ledger_adjustments` is a deduction from a seller's NEXT PAYOUT (migration 0032) and
 * `invoice_documents` is a tax document planned against a specific sale (0023). `SET NULL` is the
 * right production behaviour for both, because in production nothing ever deletes an order: an
 * adjustment is a fact about a balance and rightly outlives the case that caused it.
 *
 * Under a seeder it is the 48-phantom-`refund_due`-rows bug in a worse shape. The row survives with
 * `order_id` NULL, so no screen can say what it is FOR any more — and it goes on reducing a real
 * payout figure forever, on a dashboard the owner reads as true.
 *
 * That path opened the day `seed-returns.mjs` was written: pressing "החזר לו את הכסף" on a staged
 * case runs the real `moveReturnRequest`, which writes a `refund_clawback` against the seller's
 * balance — and the purge that removes the case would have left the deduction standing.
 *
 * Scoped by `order_id`, which is what makes it safe rather than merely tidy: a `platform_to_seller`
 * invoice is a MONTHLY document carrying no order and is never matched, and neither is an adjustment
 * somebody entered by hand.
 */
async function purgeOrderLedger(db, ids) {
  await db.query('DELETE FROM seller_ledger_adjustments WHERE order_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM invoice_documents WHERE order_id = ANY($1::uuid[])', [ids]);
}

export async function purgeOrdersOfStores(db, scopeName) {
  const scope = scopeOf(scopeName);
  await assertSubsetOfDisposable(db, 'stores', scope.stores, DISPOSABLE_STORE);

  const touchesScope = `SELECT DISTINCT order_id FROM order_stores
      WHERE store_slug IN (SELECT slug::text FROM stores WHERE ${scope.stores})`;
  const touchesKeeper = `SELECT DISTINCT order_id FROM order_stores
      WHERE store_slug NOT IN (SELECT slug::text FROM stores WHERE ${DISPOSABLE_STORE})`;

  const { rows } = await db.query(
    `SELECT order_id, order_id IN (${touchesKeeper}) AS shared FROM (${touchesScope}) s`,
  );
  const ids = rows.filter((r) => !r.shared).map((r) => r.order_id);
  const keptShared = rows.length - ids.length;
  if (!ids.length) return { deleted: 0, keptShared, journalRows: 0 };
  // Before the orders go: the refs are read OFF them, so this cannot run afterwards.
  //
  // **The checkout_ref half is narrowed to refs NO SURVIVING ORDER HOLDS, and that condition is the
  // whole correctness of it.** One checkout writes one order per store and they all carry the same
  // ref, so a cart mixing a demo store with a real one produces two orders sharing it — of which
  // this function deletes the demo one and deliberately KEEPS the other (`keptShared`, and the
  // paragraph above explains why that was once wrong at the order level). Sweeping by ref alone
  // reintroduces exactly that bug one level down: the surviving real order would lose its journal,
  // silently, and its money would then have an order and no record of how it got there.
  const journal = await db.query(
    `DELETE FROM money_events
      WHERE order_id = ANY($1::text[])
         OR (order_id IS NULL
             AND checkout_ref IS NOT NULL
             AND checkout_ref IN (SELECT checkout_ref FROM orders
                                   WHERE id = ANY($1::uuid[]) AND checkout_ref IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM orders k
                              WHERE k.checkout_ref = money_events.checkout_ref
                                AND NOT (k.id = ANY($1::uuid[]))))`,
    [ids],
  );
  // `product_reviews` references `orders` with ON DELETE RESTRICT and is deleted here for the same
  // reason `order_items` is — but it was ADDED to the schema (0033) after this function was
  // written, and nothing pointed the two at each other. `npm run seed:showcase` therefore built all
  // four stores correctly and then died on the purge:
  //
  //     update or delete on table "orders" violates RESTRICT setting of foreign key constraint
  //     "product_reviews_order_id_fkey" on table "product_reviews"
  //
  // `purgeSeededReviews` does clear reviews, but only the ones whose buyer_email carries the
  // seeded-review suffix — a review on a demo order from any other source is invisible to it and
  // holds the whole purge. Deleting by ORDER ID is what actually matches this function's scope.
  //
  // ⚠️ The general rule this is the second instance of: a new child table with a RESTRICT FK onto
  // `orders` must be added here, or the seeder breaks the next time a demo order has one.
  await db.query('DELETE FROM product_reviews WHERE order_id = ANY($1::uuid[])', [ids]);
  // The third instance of that rule, and it was already broken before anything seeded one:
  // `return_requests.order_id` is `REFERENCES orders ON DELETE RESTRICT` (migration 0030) and was
  // never added here, so a single return opened against a demo order — by `seed:returns`, or by
  // clicking through the buyer's own screen in dev — would have made every later `seed:demo` die on
  // the purge instead of on anything a person could read.
  await db.query('DELETE FROM return_requests WHERE order_id = ANY($1::uuid[])', [ids]);
  await purgeOrderLedger(db, ids);
  await db.query('DELETE FROM order_items WHERE order_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM order_stores WHERE order_id = ANY($1::uuid[])', [ids]);
  const res = await db.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [ids]);
  return { deleted: res.rowCount ?? 0, keptShared, journalRows: journal.rowCount ?? 0 };
}

/**
 * Journal rows whose order is already gone — the wreckage of every purge that ran before the one
 * above learned to take them along.
 *
 * A one-time sweep rather than a migration, because it is data cleanup on a developer's machine and
 * a migration would run against production.
 *
 * **Why deleting these is safe, stated rather than assumed — it is a DELETE on the money journal.**
 * Every event carrying an `order_id` is written by code holding an Order (`recordRefundOwed` takes
 * one, `settleStatusChange` has just persisted one), so the id being there means the order existed
 * at write time. Nothing in the application deletes an order — `order_items`/`order_stores` are
 * `ON DELETE RESTRICT` precisely so that cannot happen by accident — which leaves the seeders as the
 * only thing that removes one. So "names an order that is not there" identifies a purge, not a state
 * the platform can reach on its own.
 *
 * Events with NO order id are never touched, and that is the load-bearing half: a charge with no
 * order behind it is the 0017 shape, a real failure `reconcile.ts` reports on purpose, and it is
 * recorded against `checkout_ref` alone. This sweep must never be the thing that erases it.
 *
 * @returns {Promise<number>} rows removed
 */
export async function purgeOrphanJournalRows(db) {
  const res = await db.query(
    `DELETE FROM money_events e
      WHERE e.order_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = e.order_id)`,
  );
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
 * @param {{ purge?: 'demo'|'showcase'|{ scope: 'demo'|'showcase', includeSellers?: boolean },
 *           sellers?: any[], stores?: any[], categories?: any[], products?: any[],
 *           orders?: any[], reviews?: any[] }} catalog
 */
export async function writeCatalog(db, catalog) {
  const {
    purge: scope, sellers = [], stores = [], categories = [], products = [], orders = [],
    reviews = [], pageViews = [], favorites = [], wishlists = [],
  } = catalog;
  const scopeName = typeof scope === 'string' ? scope : scope?.scope;
  await db.query('BEGIN');
  try {
    // Orders before the stores that own them: `purge` deletes the stores, and once they are gone
    // there is no slug left to recognise their orders by (see purgeOrdersOfStores).
    if (scopeName) {
      await purgeOrdersOfStores(db, scopeName);
      await purge(db, scopeName, { includeSellers: typeof scope === 'string' || scope.includeSellers !== false });
    }
    await insertMany(db, 'sellers', ['id', 'name', 'email', 'password_hash', 'created_at'],
      sellers.map((s) => [s.id, s.name ?? '', s.email, s.passwordHash ?? '', s.createdAt ?? null]));

    await insertMany(db, 'stores', [
      'id', 'seller_id', 'slug', 'name', 'tagline', 'description', 'colors', 'categories',
      'shipping', 'banner_image', 'profile_image', 'header_logo', 'header_style', 'address',
      'address_visible', 'hours', 'hours_visible', 'demo', 'created_at',
    ], stores.map((s) => [
      s.id, s.sellerId, s.slug, s.name, s.tagline ?? '', s.description ?? '',
      JSON.stringify(s.colors ?? {}), s.categories ?? [], JSON.stringify(s.shipping ?? {}),
      s.bannerImage ?? null, s.profileImage ?? null, s.headerLogo ?? null,
      // The column is NOT NULL DEFAULT 'name' (migration 0021) and an explicit column list turns
      // that default off, so this must supply the default itself rather than pass null. 'logo' is
      // only ever written alongside a `headerLogo`, because the two are one setting: the header
      // reads the picture through `storeHeaderLogo()`, which returns nothing without both.
      s.headerLogo && s.headerStyle === 'logo' ? 'logo' : 'name',
      s.address ?? null,
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
      'category_id', 'hidden', 'blocked', 'tags', 'specs', 'variants', 'seller_note',
      'weight_grams', 'created_at',
    ], products.map((p) => [
      p.id, p.storeId, p.slug, p.name, p.description ?? '',
      toAgorot(p.price), Math.max(0, Number(p.stock) || 0), p.sku || null,
      p.categoryId ?? null, Boolean(p.hidden), Boolean(p.blocked), p.tags ?? [],
      JSON.stringify(p.specs ?? []), JSON.stringify(p.variants ?? []), p.sellerNote || null,
      // Absent is NULL, never 0 — "not supplied" and "weighs nothing" are different answers and
      // the shipping quote treats them differently (product-weight.ts). The column's CHECK
      // constraint rejects 0 outright, so a `?? 0` here would fail the whole insert.
      Number(p.weightGrams) > 0 ? Math.round(p.weightGrams) : null,
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

    // Reviews, after the orders they hang off — `product_reviews.order_id` references `orders`.
    // They need no purge line of their own: the products cascade them away (migration 0033), and
    // the orders are already gone by the time this runs on a re-seed.
    await insertMany(db, 'product_reviews', [
      'id', 'product_id', 'store_slug', 'order_id', 'buyer_id', 'reviewer_name', 'rating', 'body', 'created_at',
    ], reviews.map((r) => [
      r.id ?? randomUUID(), r.productId, r.storeSlug, r.orderId, null,
      r.reviewerName ?? '', Math.max(1, Math.min(5, Number(r.rating) || 5)), r.body ?? '', r.createdAt ?? null,
    ]));
    // The cached score is a CACHE and is rebuilt from the rows, exactly as
    // `product-reviews.ts#recomputeProductRating` does it — never counted up while inserting. A
    // seeder that maintained the number itself would be the second definition of the aggregate,
    // and it would be the one that gets it wrong on the day someone changes what counts.
    if (reviews.length) {
      await db.query(`UPDATE store_products p
                         SET review_count = agg.n, review_rating_sum = agg.total
                        FROM (SELECT product_id, count(*)::int AS n, sum(rating)::int AS total
                                FROM product_reviews WHERE NOT blocked GROUP BY product_id) agg
                       WHERE p.id = agg.product_id`);
    }

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
