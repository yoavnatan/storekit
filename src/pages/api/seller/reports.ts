export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerById, getSellerSession } from '../../../lib/seller-auth.js';
import { commissionPercentForTier } from '../../../lib/pricing.js';
import { findStoreBySlugOrPrevious, getStoresBySellerId } from '../../../lib/stores.js';
import { getOrdersByStoreSlugInRange } from '../../../lib/orders.js';
import { getProductsByStoreId } from '../../../lib/store-products.js';
import { isDayISO } from '../../../lib/business-day.js';
import { getLang } from '../../../i18n/index.js';
import {
  buildSalesReport, buildProductSalesReport, buildStockReport, isReportId, type ReportId,
} from '../../../lib/seller-reports.js';
import {
  salesReportCsv, productSalesReportCsv, stockReportCsv, reportFileName,
} from '../../../lib/seller-reports-csv.js';

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Same ceiling the performance route uses, and for the same reason: a crafted `?from=` far in the
 *  past must not be able to ask one request to build an unbounded document. */
const MAX_DAYS = 731;

/**
 * The seller's three reports, as a table (`format=json`) or as a file (`format=csv`).
 *
 * **Ownership comes from the session, never from the slug.** `getStoresBySellerId` is the whole
 * authorization: a slug that does not resolve inside THAT list is a 404, so naming another
 * seller's store reads nothing (`store-ownership.ts`, and the audit row that put it there — a
 * session proves which STORES an account owns, never which id it may name).
 *
 * `stock` deliberately ignores `from`/`to`: a stocktake is a statement about now, and accepting a
 * range there would produce a file whose name promises a period its contents do not describe.
 *
 * Every report on this tab is now store-scoped — the one account-wide report, `payouts`, went
 * with the transfers it listed (`seller-report-shapes.ts`).
 */
export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const report = url.searchParams.get('report');
  const reqSlug = url.searchParams.get('storeSlug');
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  const wantsCsv = url.searchParams.get('format') === 'csv';

  if (!isReportId(report) || !reqSlug) return json({ error: 'Missing or invalid report/storeSlug' }, 400);
  const needsRange: ReportId[] = ['sales', 'products'];
  if (needsRange.includes(report)) {
    if (!isDayISO(from) || !isDayISO(to) || from > to) return json({ error: 'Missing or invalid from/to' }, 400);
    const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / 86400000;
    if (spanDays > MAX_DAYS) return json({ error: 'Range too large' }, 400);
  }

  const stores = await getStoresBySellerId(sellerId);
  const store = findStoreBySlugOrPrevious(stores, reqSlug);
  if (!store) return json({ error: 'Store not found' }, 404);
  // The CURRENT slug — orders migrate to it on rename, and a client may still hold a cached old one.
  const storeSlug = store.slug;
  const lang = getLang(cookies);

  const csv = (body: string): Response =>
    new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${reportFileName(report, storeSlug, from, to)}"`,
        // A report is a snapshot of live data and must never be served from a cache: the seller
        // re-exports precisely because something changed.
        'Cache-Control': 'no-store',
      },
    });

  if (report === 'stock') {
    const products = await getProductsByStoreId(store.id);
    const { rows, totals } = buildStockReport(products);
    return wantsCsv ? csv(stockReportCsv(rows, lang)) : json({ ok: true, rows, totals });
  }


  if (report === 'products') {
    // Independent reads, so one round trip rather than two (AI_INSTRUCTIONS → Scalability).
    const [orders, products] = await Promise.all([
      getOrdersByStoreSlugInRange(storeSlug, from, to),
      getProductsByStoreId(store.id),
    ]);
    const { rows, totals } = buildProductSalesReport(orders, products, storeSlug, from, to);
    return wantsCsv ? csv(productSalesReportCsv(rows, lang)) : json({ ok: true, rows, totals });
  }

  const [orders, seller] = await Promise.all([getOrdersByStoreSlugInRange(storeSlug, from, to), getSellerById(sellerId)]);
  const { rows, totals } = buildSalesReport(orders, storeSlug, from, to, commissionPercentForTier(seller?.tier));
  return wantsCsv ? csv(salesReportCsv(rows, lang)) : json({ ok: true, rows, totals });
}
