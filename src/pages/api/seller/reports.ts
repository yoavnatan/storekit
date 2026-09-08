export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { chargedCommissionPercentForStore } from '../../../lib/store-plan.js';
import { findStoreBySlugOrPrevious, getStoresBySellerId } from '../../../lib/stores.js';
import { getOrdersByStoreSlugInRange } from '../../../lib/orders.js';
import { getProductsByStoreId } from '../../../lib/store-products.js';
import { isDayISO } from '../../../lib/business-day.js';
import { getLang } from '../../../i18n/index.js';
import {
  buildSalesReport, buildProductSalesReport, buildStockReport, buildFeesReport, isReportId, type ReportId,
} from '../../../lib/seller-reports.js';
import {
  salesReportCsv, productSalesReportCsv, stockReportCsv, feesReportCsv, reportFileName,
} from '../../../lib/seller-reports-csv.js';
import { getSellerStreamEvents } from '../../../lib/money-events.js';
import { SUBSCRIPTION_EVENT_STREAM } from '../../../lib/seller-subscription.js';
import { businessDayISO } from '../../../lib/business-day.js';

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Same ceiling the performance route uses, and for the same reason: a crafted `?from=` far in the
 *  past must not be able to ask one request to build an unbounded document. */
const MAX_DAYS = 731;

/** How many of the processor's transactions one fee report reads. Their endpoint has no date
 *  filter — it answers newest-first — so this is the depth of the window we can honestly cover,
 *  and a report whose period reaches past it says so (`processor: 'partial'`). */

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
  const needsRange: ReportId[] = ['sales', 'products', 'fees'];
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

  /**
   * ── The fee ledger, and the one place on this tab that talks to a third party ──
   *
   * Account-wide (`ACCOUNT_WIDE_REPORTS`): a seller has one clearing account and one standing order
   * however many shops he runs, so scoping his fees to the shop in the switcher would produce a
   * total that is missing rows. The commission half is still per-shop — `rateFor` carries each
   * shop's own plan, because two shops can sit on two plans and one blended rate would misstate
   * both.
   *
   * **The processor half degrades rather than fails.** `get-transactions` is a call to PayMe on a
   * request a seller is waiting on, and it has no date filter — it answers newest-first and we keep
   * what falls inside the window. Two honest consequences, both reported rather than hidden:
   * a failure leaves the report with our own rows and `processor: 'unavailable'`, and a window
   * older than the page we read comes back `processor: 'partial'`, which the summary says out loud
   * (AI_INSTRUCTIONS → no silent caps).
   */
  if (report === 'fees') {
    /* ── One source since 2026-09-08, and it is ours ──
       This used to merge two: our per-sale commission, derived from the orders, and the processor's
       own per-charge fee, READ live from PayMe over the seller's merchant account. Both are gone —
       we take no share of a sale, and there is no merchant account of his at our processor to read.
       So the report is the subscription charges we have a RECORD of, and there is no third party on
       the request path any longer: no `processor` state to degrade, no page limit to disclose. */
    const subCharges = await getSellerStreamEvents(sellerId, SUBSCRIPTION_EVENT_STREAM, from, to);
    const { rows, totals } = buildFeesReport({
      orders: [],
      rateFor: new Map(),
      fromISO: from,
      toISO: to,
      subscription: subCharges.map((e) => ({
        dayISO: businessDayISO(new Date(e.at)),
        reference: e.detail ?? '',
        amountAgorot: e.amountAgorot ?? 0,
      })),
    });
    return wantsCsv ? csv(feesReportCsv(rows, lang)) : json({ ok: true, rows, totals, processor: 'none' });
  }

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

  // The commission rate comes off the STORE now (`lib/store-plan.ts`), so the seller row this used
  // to fetch alongside the orders is no longer read at all — one fewer round trip on a report page.
  //
  // **The CHARGED rate.** This report's commission column is a DEDUCTION from the seller's sale and
  // its payout column is what he actually keeps, so it has to be the percent PayMe really took —
  // the plan's rate plus VAT (`store-plan.ts#chargedCommissionPercentForStore`). Passing the quoted
  // rate would print a payout 18% of the commission higher than the money that reached him.
  const orders = await getOrdersByStoreSlugInRange(storeSlug, from, to);
  const { rows, totals } = buildSalesReport(orders, storeSlug, from, to, chargedCommissionPercentForStore(store));
  return wantsCsv ? csv(salesReportCsv(rows, lang)) : json({ ok: true, rows, totals });
}
