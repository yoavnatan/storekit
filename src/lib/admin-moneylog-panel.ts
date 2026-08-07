import { getMoneyEventDay, getMoneyEventsPage, moneyEventPage, type MoneyEvent } from './money-events.js';
import { parseMoneyLogQuery, widenToEvent, type MoneyLogQuery } from './admin-moneylog-filter.js';
import { ADMIN_PAGE_SIZE, parsePage } from './pagination.js';

/**
 * Everything the admin money-journal tab renders, assembled from the URL — the page frontmatter's
 * share of this tab, moved out of `admin/index.astro` so the ORDER of its three possible queries is
 * stated once, in one place, instead of being spread across that page's dependency waves.
 *
 * The order matters and is not arbitrary. A `?mev=` permalink can name a row older than the default
 * 30-day window, so the row's day has to be resolved BEFORE the window is known, and the window has
 * to be known before the page holding the row can be counted. That is a genuine chain, so it is
 * written as one — and it costs what it looks like it costs:
 *
 *   · no permalink (the normal case) → ONE round trip: the page itself.
 *   · `?mev=`                        → three: the row's day, its rank, then the page.
 *
 * Written the other way round — one wave of "everything this tab might need" — the normal case
 * would pay for the permalink case on every load.
 */
export interface MoneyLogPanelData {
  events: MoneyEvent[];
  query: MoneyLogQuery;
  /** A `?mev=` permalink whose row isn't in the current result set. */
  targetMissing: boolean;
  /** Rows matching the active narrowing, across all pages. */
  total: number;
  page: number;
  totalPages: number;
}

export async function loadMoneyLogPanel(sp: URLSearchParams, pageSize = ADMIN_PAGE_SIZE): Promise<MoneyLogPanelData> {
  const requested = parseMoneyLogQuery(sp);
  // A `?mev=` permalink widens the default window back to the row it names — otherwise every link
  // older than 30 days would answer "this row is not in the current filter", which is the exact
  // failure `targetMissing` exists to report, arriving by default.
  const query = widenToEvent(requested, await getMoneyEventDay(requested.eventId));

  // Which page holds the linked row — unknowable to the client, since it depends on the filters and
  // on every row appended since the link was copied. Asked whenever there IS a link, even when
  // `?mlpage` overrides the answer: `null` is also how "this filter doesn't contain that row" is
  // reported, and the panel says so out loud rather than swallowing it into "here's page 1".
  const targetPage = query.eventId ? await moneyEventPage(query, query.eventId, pageSize) : null;
  const targetMissing = query.eventId !== '' && targetPage === null;

  // An explicit `?mlpage` always wins, or the next arrow click would snap back to the linked row.
  const explicitPage = sp.get('mlpage') ? parsePage(sp, 'mlpage') : null;
  const wanted = explicitPage ?? targetPage ?? 1;
  const first = await getMoneyEventsPage(query, (wanted - 1) * pageSize, pageSize);
  const totalPages = Math.max(1, Math.ceil(first.total / pageSize));
  if (wanted <= totalPages) {
    return { events: first.events, query, targetMissing, total: first.total, page: wanted, totalPages };
  }
  // Past the end — a hand-typed `?mlpage=999`. The in-memory pager used to clamp silently, and it
  // still should: an admin who over-shoots gets the last page, not a blank one. This costs a second
  // round trip in a case that cannot happen by clicking anything.
  const last = await getMoneyEventsPage(query, (totalPages - 1) * pageSize, pageSize);
  return { events: last.events, query, targetMissing, total: last.total, page: totalPages, totalPages };
}
