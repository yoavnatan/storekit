import { businessDayISO, dayInRange } from './business-day.js';
import { ADMIN_PAGE_SIZE } from './pagination.js';
import { isMoneyEventType, MONEY_EVENT_LABELS, type MoneyEvent, type MoneyEventType } from './money-events.js';

/**
 * Server-side counterpart of the admin money-journal tab's toolbar
 * (src/scripts/admin/moneylog.ts) — the same split admin-orders-filter.ts already
 * uses: filter over the WHOLE journal, then slice to a page.
 *
 * Why it exists (owner, סשן ג׳): the journal was a filter-by-type list and nothing
 * else, so the only way to reach one specific row was to page through until it
 * appeared. Three things were missing and all three are navigation, not display:
 * free-text search (an order id, an אסמכתא, a store), a date window, and a way to
 * link straight AT a row.
 *
 * The narrowing lives here, not in money-events.ts, exactly as that module's own
 * header asks: `getMoneyEvents` owns the vocabulary-level type filter (so it applies
 * before any slicing), and anything per-order / per-store / per-day is a filter over
 * its result. This module is that filter — and it is pure, so every rule below is
 * unit-tested without a journal file on disk.
 */

export interface MoneyLogQuery {
  /** Vocabulary-validated, so an unknown `?mtype=` narrows to nothing rather than
   *  silently falling back to "show everything" (see money-events.ts). */
  type?: MoneyEventType;
  /** Free text; '' = no search. Space-separated terms are ANDed. */
  q: string;
  /** Business-day bounds, 'YYYY-MM-DD'; '' = open-ended on that side. */
  from: string;
  to: string;
  /** A single event's id, from a copied row permalink (`?mev=`). */
  eventId: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_FROM = '0000-01-01';
const OPEN_TO = '9999-12-31';

/**
 * Every term is tested against every row, so the work is (terms × rows) — and both
 * halves are request-controlled on a single-threaded SSR server. A query string can
 * carry ~16KB, which as `a a a a …` is ~8,000 terms against the whole journal for one
 * page load. No real search is longer than this, so the cap costs nothing and removes
 * the amplification (same reasoning as the ReDoS guards in `lib/url-base.ts`).
 */
const MAX_SEARCH_LENGTH = 200;

/** Parses the money-journal tab's own params (mtype/mq/mfrom/mto/mev). Kept beside the
 *  filter so the two things that must agree — what a param means and what the filter
 *  expects — cannot drift. Every param is registered in ADMIN_TAB_PARAMS
 *  (admin-nav.ts), enforced by tests/admin-tab-params.test.ts. */
export function parseMoneyLogQuery(sp: URLSearchParams): MoneyLogQuery {
  const type = sp.get('mtype') ?? '';
  let from = DAY_RE.test(sp.get('mfrom') ?? '') ? sp.get('mfrom')! : '';
  let to = DAY_RE.test(sp.get('mto') ?? '') ? sp.get('mto')! : '';
  // An inverted range is a picker slip, not a request for an empty result — the two
  // native date inputs let either be set first, and answering "0 events" to a range
  // the admin can see contains rows reads as a broken filter.
  if (from && to && from > to) [from, to] = [to, from];
  return {
    type: isMoneyEventType(type) ? type : undefined,
    q: (sp.get('mq') ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
    from,
    to,
    eventId: (sp.get('mev') ?? '').trim(),
  };
}

/** Everything about one row a search may legitimately match — including the Hebrew
 *  label the admin is reading on screen, and the amount as typed (`349`). Order ids are
 *  displayed truncated to 8 chars, and `includes` on the full id covers that for free. */
function searchHaystack(e: MoneyEvent): string {
  return [
    e.orderId,
    e.checkoutRef,
    e.storeSlug,
    e.actor,
    e.detail,
    e.from,
    e.to,
    MONEY_EVENT_LABELS[e.type],
    e.type,
    e.amount !== undefined ? String(e.amount) : '',
  ].filter(Boolean).join(' ').toLowerCase();
}

/** Rows are ANDed across every active narrowing, and search terms are ANDed with each
 *  other: "מוצרים ביטול" means both, which is what makes a two-word guess narrow
 *  instead of widen. */
export function filterMoneyEvents(events: MoneyEvent[], query: MoneyLogQuery): MoneyEvent[] {
  const from = query.from || OPEN_FROM;
  const to = query.to || OPEN_TO;
  const bounded = Boolean(query.from || query.to);
  const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);

  return events.filter((e) => {
    if (query.type && e.type !== query.type) return false;
    // The SAME calendar every report buckets by (business-day.ts) — a row found by
    // searching "29 ביולי" here must be the row the seller's chart counts that day.
    if (bounded && !dayInRange(businessDayISO(new Date(e.at)), from, to)) return false;
    if (terms.length) {
      const hay = searchHaystack(e);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
}

/** Which page of the CURRENT result set holds `eventId` — the answer to "open this
 *  link and show me that row", which is otherwise unknowable to the client: the row's
 *  page depends on filters and on rows appended since the link was copied. `null` = the
 *  event isn't in this result set (wrong filter, or a journal that no longer has it),
 *  and the panel says so rather than silently showing page 1. */
export function eventPage(events: MoneyEvent[], eventId: string, pageSize = ADMIN_PAGE_SIZE): number | null {
  if (!eventId) return null;
  const index = events.findIndex((e) => e.id === eventId);
  return index === -1 ? null : Math.floor(index / pageSize) + 1;
}

/** Is anything narrowing the journal right now? Drives the "clear" affordance and the
 *  empty-state wording — "no events of this kind" and "nothing logged yet" are
 *  different answers, and showing the wrong one is how a working filter looks broken. */
export function hasActiveMoneyLogFilters(query: MoneyLogQuery): boolean {
  return Boolean(query.type || query.q || query.from || query.to);
}
