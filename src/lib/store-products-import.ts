import { getProductsByStoreId } from './store-products.js';
import { bulkUpsertProducts } from './store-products-bulk.js';
import {
  parseCsv, mapHeader, toRawRows, validateRows, resolveSkuMatches,
  MAX_IMPORT_ROWS, type SkuMatchTarget,
} from './csv-bulk.js';
import { mergeVariantGroups } from './variant-csv.js';
import { deleteNotificationsByRelatedIds } from './notifications.js';

// Single home for the whole CSV → catalog routine, so the two things that trigger it — the seller
// uploading/pasting a canonical file (POST /api/store-product/bulk) and the "sync now" URL pull
// (POST /api/store-product/feed-sync) — run identical validation, variant grouping, sku-matching and
// notification cleanup. matchBySku is the only behavioural fork (external-feed sync), and it's opt-in:
// the plain bulk import passes it false and behaves exactly as before this module existed.

export interface ImportResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

export interface RunImportOptions {
  storeId: string;
  sellerId: string;
  csv: string;
  /** false = dry run (preview counts + per-row resolution), true = write to the catalog. */
  commit: boolean;
  /** External-feed sync: match rows to existing products by sku instead of only the internal id. */
  matchBySku: boolean;
  lang: 'he' | 'en';
}

export function runProductImport({ storeId, sellerId, csv, commit, matchBySku, lang }: RunImportOptions): ImportResult {
  const rows = parseCsv(csv);
  if (!rows.length) return { ok: false, status: 400, body: { ok: false, error: 'empty-file' } };
  if (rows.length - 1 > MAX_IMPORT_ROWS) return { ok: false, status: 400, body: { ok: false, error: 'too-many-rows' } };

  const { map, missing } = mapHeader(rows[0]!);
  if (missing.length) return { ok: false, status: 400, body: { ok: false, error: 'missing-columns', missing } };

  const existingProducts = getProductsByStoreId(storeId);
  const existingIds = new Set(existingProducts.map((p) => p.id));
  // Owner map spans product-level AND per-combo skus so a re-imported variant product's own combo
  // codes read as self-owned (no false duplicate), and any sku already live anywhere collides.
  const existingSkuOwners = new Map<string, string>();
  for (const p of existingProducts) {
    if (p.sku) existingSkuOwners.set(p.sku, p.id);
    for (const s of Object.values(p.variantSku ?? {})) existingSkuOwners.set(s, p.id);
  }

  const rawRows = toRawRows(rows, map);
  if (matchBySku) {
    // Resolve each sku-keyed row to the product it updates (and backfill blank name/price) before
    // validation, so the rest of the pipeline sees ordinary id-matched update rows.
    const catalogBySku = new Map<string, SkuMatchTarget>();
    for (const p of existingProducts) if (p.sku) catalogBySku.set(p.sku, { id: p.id, name: p.name, price: p.price });
    resolveSkuMatches(rawRows, catalogBySku);
  }

  // Per-row validation first (name/price/sku/spam/category), then collapse variant-group rows into
  // one product each — errors stay per-line, grouping is a separate testable pass.
  const rowResults = validateRows(rawRows, existingIds, existingSkuOwners);
  const results = mergeVariantGroups(rowResults, lang);

  if (!commit) {
    // The id column is a plain UUID a seller has no real reason to look at or trust blindly —
    // surfacing the product it currently resolves to lets them visually catch a scrambled/wrong-row
    // mistake before anything is written, which a plain-text CSV can't otherwise guard against.
    const byId = new Map(existingProducts.map((p) => [p.id, p]));
    return {
      ok: true, status: 200,
      body: { ok: true, results: results.map((r) => (r.action === 'update' && r.id ? { ...r, currentName: byId.get(r.id)?.name } : r)) },
    };
  }

  // bulkUpsertProducts returns exactly one result per input product, in the same order — safe to
  // pair positionally with validRows (never silently drops one, even if an id ever fails to match).
  const validRows = results.filter((r) => r.action !== 'error' && r.input);
  const upserted = bulkUpsertProducts(storeId, validRows.map((r) => ({ id: r.id, ...r.input! })));

  // An update row that explicitly set a stock value (blank cells preserve the existing stock) —
  // treat that the same as the single-product edit form: the seller reviewed/re-entered stock, so
  // any low-stock/out-of-stock alert for the product is acknowledged.
  const restockedIds = upserted
    .map((u, i) => (u.action === 'update' && validRows[i]!.input!.stock !== undefined ? u.id : null))
    .filter((id): id is string => !!id);
  if (restockedIds.length) deleteNotificationsByRelatedIds(restockedIds, sellerId);

  let cursor = 0;
  return {
    ok: true, status: 200,
    body: {
      ok: true,
      results: results.map((r) => {
        if (r.action === 'error') return r;
        const match = upserted[cursor++];
        if (!match || match.action === 'not-found') return { ...r, action: 'error' as const, errors: ['id-not-found'] };
        return { ...r, product: match.product };
      }),
    },
  };
}
