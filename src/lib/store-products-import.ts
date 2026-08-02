import { getProductsByStoreId } from './store-products.js';
import { bulkUpsertProducts, updateChangesProduct, CSV_MAX_DIMENSIONS } from './store-products-bulk.js';
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

export async function runProductImport({ storeId, sellerId, csv, commit }: RunImportOptions): Promise<ImportResult> {
  const rows = parseCsv(csv);
  if (!rows.length) return { ok: false, status: 400, body: { ok: false, error: 'empty-file' } };
  if (rows.length - 1 > MAX_IMPORT_ROWS) return { ok: false, status: 400, body: { ok: false, error: 'too-many-rows' } };

  const { map, missing } = mapHeader(rows[0]!);
  if (missing.length) return { ok: false, status: 400, body: { ok: false, error: 'missing-columns', missing } };

  // Read once, for the preview and the diff below. This pass is advisory — it is what the seller
  // is shown before committing — and the authoritative read happens again inside bulkUpsertProducts'
  // transaction, which is what a row is actually applied against.
  const categories = await getCategoriesByStoreId(storeId);
  const existingProducts = await getProductsByStoreId(storeId);
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
  const pathOf = (categoryId?: string): string[] => (categoryId ? getAncestorChain(categories, categoryId).map((c) => c.name) : []);
  for (const r of results) {
    if (r.action !== 'update' || !r.id || !r.input) continue;
    const existing = byId.get(r.id);
    if (!existing) continue;
    r.currentName = existing.name;
    r.unchanged = !updateChangesProduct(existing, r.input, pathOf(existing.categoryId));
    // A flat row (no option columns) carrying a NEW stock number for a product whose stock lives
    // per-combo would write a value that governs nothing: a purchase decrements the combo's own
    // bucket (resolveStockField in store-products.ts), so the seller would be told the row updated
    // the product while every combo kept selling its old quantity. That is the shape a sku+stock
    // feed produces for a variant product, and it is exactly how a "set it to 3" ends as an
    // oversell. Reject the row instead. An unchanged stock cell (the 4+-dimension export's flat
    // total re-imported) is not affected: it never reaches here, `unchanged` already covers it.
    //
    // Two different fixes, so two different messages: with up to CSV_MAX_DIMENSIONS the seller can
    // spell the combos out in the option columns, but beyond that the file physically cannot express
    // the product (that is why it exported flat), so the dashboard is the only route — telling that
    // seller to "fill in the option columns" would send them after a column that doesn't exist.
    if (
      !r.unchanged
      && !r.input.variants?.length
      && existing.variants?.length
      && Object.keys(existing.variantStock ?? {}).length > 0
      && r.input.stock !== undefined
      && r.input.stock !== existing.stock
    ) {
      r.action = 'error';
      r.errors = [...r.errors, existing.variants.length > CSV_MAX_DIMENSIONS
        ? 'variant-stock-dashboard-only'
        : 'variant-stock-needs-combos'];
    }
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
  const upserted = await bulkUpsertProducts(storeId, validRows.map((r) => ({ id: r.id, ...r.input! })));

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
