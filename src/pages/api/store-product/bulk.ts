export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { getProductsByStoreId } from '../../../lib/store-products.js';
import { bulkUpsertProducts } from '../../../lib/store-products-bulk.js';
import { parseCsv, mapHeader, toRawRows, validateRows, productsToCsv, MAX_IMPORT_ROWS } from '../../../lib/csv-bulk.js';
import { getLang } from '../../../i18n/index.js';
import { deleteNotificationsByRelatedIds } from '../../../lib/notifications.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function authorizeStore(sellerId: string, storeId: string): boolean {
  return !!getStoresBySellerId(sellerId).find((s) => s.id === storeId);
}

export const GET: APIRoute = ({ url, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Not authenticated' }, 401);
  const storeId = url.searchParams.get('storeId') ?? '';
  if (!storeId || !authorizeStore(sellerId, storeId)) return json({ error: 'Not authorized' }, 403);

  const csv = productsToCsv(getProductsByStoreId(storeId), getLang(cookies));
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="products.csv"',
    },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const body = await request.json() as { storeId?: string; csv?: string; commit?: boolean };
  const storeId = body.storeId ?? '';
  if (!storeId || !authorizeStore(sellerId, storeId)) return json({ ok: false, error: 'Not authorized' }, 403);

  const rows = parseCsv(String(body.csv ?? ''));
  if (!rows.length) return json({ ok: false, error: 'empty-file' }, 400);
  if (rows.length - 1 > MAX_IMPORT_ROWS) return json({ ok: false, error: 'too-many-rows' }, 400);

  const { map, missing } = mapHeader(rows[0]!);
  if (missing.length) return json({ ok: false, error: 'missing-columns', missing }, 400);

  const existingProducts = getProductsByStoreId(storeId);
  const existingIds = new Set(existingProducts.map((p) => p.id));
  const existingSkuOwners = new Map(existingProducts.filter((p) => p.sku).map((p) => [p.sku!, p.id]));
  const results = validateRows(toRawRows(rows, map), existingIds, existingSkuOwners);

  if (!body.commit) {
    // The id column is a plain UUID a seller has no real reason to look at or trust blindly —
    // surfacing the product it currently resolves to lets them visually catch a scrambled/
    // wrong-row mistake (a valid id pointing at the wrong product) before anything is written,
    // which a CSV can't otherwise guard against (no cell-locking in a plain-text format).
    const byId = new Map(existingProducts.map((p) => [p.id, p]));
    return json({
      ok: true,
      results: results.map((r) => (r.action === 'update' && r.id ? { ...r, currentName: byId.get(r.id)?.name } : r)),
    });
  }

  // bulkUpsertProducts returns exactly one result per input row, in the same order — safe to
  // pair positionally with validRows (never silently drops a row, even if an id ever fails to match).
  const validRows = results.filter((r) => r.action !== 'error' && r.input);
  const upserted = bulkUpsertProducts(storeId, validRows.map((r) => ({ id: r.id, ...r.input! })));

  // An update row that explicitly set a stock value (blank cells preserve the
  // existing stock, see bulkUpsertProducts) — treat that the same as the
  // single-product edit form: the seller reviewed/re-entered stock, so any
  // low-stock/out-of-stock alert for the product is acknowledged.
  const restockedIds = upserted
    .map((u, i) => (u.action === 'update' && validRows[i]!.input!.stock !== undefined ? u.id : null))
    .filter((id): id is string => !!id);
  if (restockedIds.length) deleteNotificationsByRelatedIds(restockedIds, sellerId);

  let cursor = 0;
  return json({
    ok: true,
    results: results.map((r) => {
      if (r.action === 'error') return r;
      const match = upserted[cursor++];
      if (!match || match.action === 'not-found') return { ...r, action: 'error' as const, errors: ['id-not-found'] };
      return { ...r, product: match.product };
    }),
  });
};
