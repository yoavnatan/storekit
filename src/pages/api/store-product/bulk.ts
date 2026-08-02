export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { getProductsByStoreId } from '../../../lib/store-products.js';
import { getCategoriesByStoreId } from '../../../lib/store-categories.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { productsToCsv } from '../../../lib/store-products-bulk.js';
import { runProductImport } from '../../../lib/store-products-import.js';
import { getLang } from '../../../i18n/index.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function authorizeStore(sellerId: string, storeId: string): Promise<boolean> {
  return !!(await getStoresBySellerId(sellerId)).find((s) => s.id === storeId);
}

export const GET: APIRoute = async ({ url, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Not authenticated' }, 401);
  const storeId = url.searchParams.get('storeId') ?? '';
  if (!storeId || !await authorizeStore(sellerId, storeId)) return json({ error: 'Not authorized' }, 403);

  const csv = productsToCsv(await getProductsByStoreId(storeId), await getCategoriesByStoreId(storeId), getLang(cookies));
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

  const read = await readJsonBody<{ storeId?: string; csv?: string; commit?: boolean }>(request, BODY_LIMIT.upload);
  if (!read.ok) return json({ ok: false, error: read.status === 413 ? 'הקובץ גדול מדי' : 'Invalid body' }, read.status);
  const body = read.value;
  const storeId = body.storeId ?? '';
  if (!storeId || !await authorizeStore(sellerId, storeId)) return json({ ok: false, error: 'Not authorized' }, 403);

  const { status, body: resBody } = await runProductImport({
    storeId, sellerId, csv: String(body.csv ?? ''),
    commit: !!body.commit,
  });
  return json(resBody, status);
};
