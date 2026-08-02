export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { getStoresBySellerId, updateStore } from '../../../lib/stores.js';
import { fetchFeedCsv } from '../../../lib/feed-fetch.js';
import { parseCsv } from '../../../lib/csv-bulk.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { guessMapping, buildCanonicalCsv, type MappableKey } from '../../../lib/feed-mapping.js';
import { runProductImport } from '../../../lib/store-products-import.js';

// "Sync now": server-side pull of the store's saved external-inventory feed. Fetches the URL (behind
// the SSRF guard), re-applies the saved column mapping to turn it into our canonical format, then
// runs the exact same import routine as a manual upload — which matches rows to existing products by
// sku when they carry no id, exactly what a feed keyed by the store's own sku needs. Two calls:
// commit:false for the preview, commit:true to write. When a scheduler exists this same endpoint is
// what it will call on a timer (see CURRENT_TASK / GO_LIVE).

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const read = await readJsonBody<{ storeId?: string; commit?: boolean }>(request, BODY_LIMIT.control);
  if (!read.ok) return json({ ok: false, error: 'Invalid body' }, read.status);
  const body = read.value;
  const store = (await getStoresBySellerId(sellerId)).find((s) => s.id === (body.storeId ?? ''));
  if (!store) return json({ ok: false, error: 'Not authorized' }, 403);

  const url = store.feedSync?.url?.trim();
  if (!url) return json({ ok: false, error: 'no-feed-url' }, 400);

  const fetched = await fetchFeedCsv(url);
  if (!fetched.ok || fetched.csv === undefined) return json({ ok: false, error: `feed-${fetched.error}` }, 502);

  const rows = parseCsv(fetched.csv);
  if (!rows.length) return json({ ok: false, error: 'empty-file' }, 400);

  // Guess from the live headers, biased by whatever mapping the seller confirmed last time.
  const saved = store.feedSync?.mapping as Record<string, MappableKey> | undefined;
  const entries = guessMapping(rows[0]!, saved);
  const canonicalCsv = buildCanonicalCsv(rows, entries);

  const { status, body: resBody } = await runProductImport({
    storeId: store.id, sellerId, csv: canonicalCsv,
    commit: !!body.commit,
  });

  if (body.commit && resBody.ok) {
    const lastSyncAt = new Date().toISOString();
    await updateStore(store.id, { feedSync: { ...store.feedSync, lastSyncAt } });
    return json({ ...resBody, lastSyncAt }, status);
  }
  return json(resBody, status);
};
