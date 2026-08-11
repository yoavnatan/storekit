export const prerender = false;
import type { APIContext } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { businessTodayISO, isDayISO } from '../../../lib/business-day.js';
import { loadPlatformStatement } from '../../../lib/admin-statement-load.js';
import { monthPeriod, statementPeriod } from '../../../lib/platform-statement.js';
import { platformStatementCsv, statementFileName } from '../../../lib/platform-statement-csv.js';

/**
 * The platform's accounting statement, as a table (`format=json`) or as a file (`format=csv`).
 *
 * Admin cookie only, like every other route in this folder — this is the platform's own books, and
 * there is no seller-scoped version of it: `requireAdmin` returns a ready 401 when the caller is
 * anyone else, including a signed-in seller.
 *
 * **Read-only, and the whole document comes from `loadPlatformStatement`** — the same function the
 * dashboard panel renders from, so the file the accountant receives and the screen the owner is
 * looking at cannot be two different statements of the same month.
 *
 * Two ways to name a period, and they converge: `?month=YYYY-MM`, or `?from=&to=`. A free range
 * that happens to cover exactly one calendar month IS that month (`statementPeriod`), so the two
 * spellings cannot produce documents that describe the same period differently.
 */

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Same ceiling as the seller reports route, for the same reason: a crafted `?from=` far in the past
 *  must not let one request build an unbounded document. Here the queries are aggregates and would
 *  survive it — the bound is on the CLAIM, since a statement spanning years has an opening balance
 *  nobody asked for and a title nobody can check. */
const MAX_DAYS = 731;

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const url = new URL(request.url);
  const month = url.searchParams.get('month') ?? '';
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';

  let period;
  if (month) {
    if (!MONTH_KEY.test(month)) return json({ error: 'Invalid month' }, 400);
    period = monthPeriod(month);
  } else {
    if (!isDayISO(from) || !isDayISO(to) || from > to) return json({ error: 'Missing or invalid from/to' }, 400);
    const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / 86400000;
    if (spanDays > MAX_DAYS) return json({ error: 'Range too large' }, 400);
    period = statementPeriod(from, to);
  }

  const statement = await loadPlatformStatement(period, businessTodayISO());

  if (url.searchParams.get('format') === 'csv') {
    return new Response(platformStatementCsv(statement), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${statementFileName(statement)}"`,
        // Computed live from orders and payouts as they are now, so a cached copy is a stale claim
        // about a period — and re-exporting is exactly what someone does when something changed.
        'Cache-Control': 'no-store',
      },
    });
  }
  return json({ ok: true, statement });
}
