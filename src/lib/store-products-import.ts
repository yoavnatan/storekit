import { getProductsByStoreId } from './store-products.js';
import { bulkUpsertProducts, updateChangesProduct } from './store-products-bulk.js';
import { getCategoriesByStoreId, getAncestorChain } from './store-categories.js';
import {
  parseCsv, mapHeader, toRawRows, validateRows, resolveSkuMatches,
  MAX_IMPORT_ROWS, type SkuMatchTarget,
} from './csv-bulk.js';
import { mergeVariantGroups } from './variant-csv.js';
import { deleteNotificationsByRelatedIds } from './notifications.js';

// Single home for the whole CSV → catalog routine, so the two things that trigger it — the seller
// uploading/pasting a canonical file (POST /api/store-product/bulk) and the "sync now" URL pull
// (POST /api/store-product/feed-sync) — run identical validation, variant grouping, sku-matching and
// notification cleanup. Both paths behave identically: a row resolves to an existing product by its
// id if present, else by an already-existing sku, else it's a create (see resolveSkuMatches). This
// lets a seller re-upload their own Excel (which has skus, not our ids) to update stock, with no
// special mode to pick — id still wins whenever it's there, so export→edit→import is unchanged.

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
}

export function runProductImport({ storeId, sellerId, csv, commit }: RunImportOptions): ImportResult {
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
  // Resolve each id-less, sku-keyed row to the product it updates (and backfill blank name/price)
  // before validation, so the rest of the pipeline sees ordinary id-matched update rows. A row that
  // already carries an id is left untouched (id always wins); an unknown sku flows through as a create.
  const catalogBySku = new Map<string, SkuMatchTarget>();
  for (const p of existingProducts) if (p.sku) catalogBySku.set(p.sku, { id: p.id, name: p.name, price: p.price });
  resolveSkuMatches(rawRows, catalogBySku);

  // Per-row validation first (name/price/sku/spam/category), then collapse variant-group rows into
  // one product each — errors stay per-line, grouping is a separate testable pass.
  const rowResults = validateRows(rawRows, existingIds, existingSkuOwners);
  const results = mergeVariantGroups(rowResults);

  // Flag every update row whose values are identical to the existing product — a no-op. Both the
  // id column (a plain UUID the seller can't trust blindly) and, more importantly at scale, the
  // "unchanged" flag are attached here so the preview can surface the resolved product and hide the
  // (usually large) majority of rows that change nothing. A re-uploaded catalog or a sku+stock feed
  // is mostly no-ops; listing hundreds of them to "confirm" is unusable.
  const byId = new Map(existingProducts.map((p) => [p.id, p]));
  const categories = getCategoriesByStoreId(storeId);
  const pathOf = (categoryId?: string): string[] => (categoryId ? getAncestorChain(categories, categoryId).map((c) => c.name) : []);
  for (const r of results) {
    if (r.action !== 'update' || !r.id || !r.input) continue;
    const existing = byId.get(r.id);
    if (!existing) continue;
    r.currentName = existing.name;
    r.unchanged = !updateChangesProduct(existing, r.input, pathOf(existing.categoryId));
    // For a changed variant product, pin down WHICH combo rows actually differ (stock/sku) so the
    // preview points at those exact lines — "edited one variant" reads as one row, not the whole span.
    if (!r.unchanged && r.input.variants?.length && r.comboLineByKey) {
      const eStock = existing.variantStock ?? {}, eSku = existing.variantSku ?? {};
      const iStock = r.input.variantStock ?? {}, iSku = r.input.variantSku ?? {};
      r.changedCombos = Object.keys(r.comboLineByKey)
        .filter((k) => iStock[k] !== eStock[k] || (iSku[k] ?? '') !== (eSku[k] ?? ''))
        .map((k) => ({ line: r.comboLineByKey![k]!, label: r.comboLabelByKey?.[k] ?? '' }))
        .sort((a, b) => a.line - b.line);
    }
    // These per-combo maps were only needed for the diff above — don't ship them to the client.
    delete r.comboLineByKey;
    delete r.comboLabelByKey;
  }

  if (!commit) return { ok: true, status: 200, body: { ok: true, results } };

  // Commit skips unchanged rows entirely (nothing to write, no restock-notification churn). validRows
  // and the cursor below both skip error AND unchanged rows in lock-step, so positional pairing with
  // bulkUpsertProducts' output stays exact.
  const validRows = results.filter((r) => r.action !== 'error' && !r.unchanged && r.input);
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
        if (r.action === 'error' || r.unchanged) return r;
        const match = upserted[cursor++];
        if (!match || match.action === 'not-found') return { ...r, action: 'error' as const, errors: ['id-not-found'] };
        return { ...r, product: match.product };
      }),
    },
  };
}
