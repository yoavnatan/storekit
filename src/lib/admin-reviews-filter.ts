import { isDayISO } from './business-day.js';

/**
 * The Reviews tab's toolbar state — URL in, question out.
 *
 * **Why this tab exists at all (owner, 2026-08-19).** The review list used to be a panel on
 * "התראות ושגיאות", which he rejected on the same principle he applied to the visitor reports
 * beside it: that tab is a log of failures the machine detected, and a buyer's published opinion is
 * neither a failure nor something the machine detected. It was there for one reason — a complaint
 * about a review landed two panels above it, so the takedown button happened to be within reach —
 * and that reason is gone now that a complaint arrives as a thread carrying the review and its
 * button inline. What was left was a list with no home, and a list is a tab.
 *
 * **The narrowing is the whole point of moving it.** As a panel it was the newest 25 with no way to
 * ask anything: no search, no way to see one store's reviews, no way back to something hidden last
 * month. The four questions this answers are the four somebody actually arrives with — whose store,
 * whose account, when, and "the one that said X".
 *
 * `seller` and `store` are both here and are not the same question, for the reason the Orders tab
 * already carries: one account can run several stores, so "this seller's reviews" and "this store's
 * reviews" have different answers and only one of them is a slug.
 *
 * Parsing only — the narrowing itself runs in SQL (`product-reviews.ts#getAdminReviewsPage`),
 * because this table grows with every purchase on the platform and reading it whole to render
 * fifteen rows is the shape §3 of DB_MIGRATION_PLAN.md was written to remove.
 */

/**
 * Same cap, and the same reason, as the money journal's search: every term becomes another arm of
 * an `OR` in the `WHERE`, and both the term count and the row count are request-controlled on a
 * single-threaded SSR server. No real search is longer than this.
 */
const MAX_SEARCH_LENGTH = 200;
const MAX_SEARCH_TERMS = 8;

/** Which rows the state filter admits. `all` is the default: an admin opening this tab is browsing,
 *  not auditing, and a list that opened pre-filtered would misreport the platform to itself. */
export type ReviewStateFilter = 'all' | 'hidden' | 'published';

export interface AdminReviewQuery {
  /** Free text over the review body, the reviewer's name and the product's. Space-separated terms
   *  are ANDed. '' = no search. */
  q: string;
  /** A store slug; '' = every store. */
  store: string;
  /** A seller's account id; '' = every seller. */
  seller: string;
  state: ReviewStateFilter;
  /** Calendar-day bounds, 'YYYY-MM-DD'; '' = open-ended on that side. */
  from: string;
  to: string;
  page: number;
}

function parseDay(raw: string | null): string {
  const value = (raw ?? '').trim();
  return isDayISO(value) ? value : '';
}

export function parseAdminReviewQuery(sp: URLSearchParams): AdminReviewQuery {
  const stateRaw = sp.get('vstate');
  const pageRaw = parseInt(sp.get('vpage') ?? '1', 10);
  return {
    q: (sp.get('vq') ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
    store: (sp.get('vstore') ?? '').trim().slice(0, 120),
    seller: (sp.get('vseller') ?? '').trim().slice(0, 64),
    state: stateRaw === 'hidden' || stateRaw === 'published' ? stateRaw : 'all',
    from: parseDay(sp.get('vfrom')),
    to: parseDay(sp.get('vto')),
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** The search terms, as the query will actually use them — bounded here rather than at the call
 *  site so the cap cannot be forgotten by the next caller. */
export function reviewSearchTerms(q: string): string[] {
  return q.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
}

/** Is anything narrowed right now? Drives the toolbar's "נקה סינון" — which is not offered when
 *  there is nothing to clear, because a permanently visible clear button reads as an active filter. */
export function hasActiveReviewFilters(query: AdminReviewQuery): boolean {
  return !!(query.q || query.store || query.seller || query.from || query.to) || query.state !== 'all';
}

/** The toolbar's params, for `buildAdminUrl` — one place, so a pager link and a filter change can
 *  never disagree about which of them survives the other. */
export function reviewQueryParams(query: AdminReviewQuery): Record<string, string | undefined> {
  return {
    vq: query.q || undefined,
    vstore: query.store || undefined,
    vseller: query.seller || undefined,
    vstate: query.state !== 'all' ? query.state : undefined,
    vfrom: query.from || undefined,
    vto: query.to || undefined,
  };
}
