/**
 * How loud one error-log entry is. One rule, one file, no database.
 *
 * **What severity is for, and it is not "how bad does this look".** It answers a single question:
 * *would you want to be interrupted for this?* Every judgement below follows from that and from
 * nothing else, which is why the levels are three and not seven. A scale with more steps invites
 * arguing about the middle, and nobody has ever been paged by a `notice`.
 *
 * - `critical` — a buyer could not complete a purchase, or money/stock state may now be wrong.
 *   This is the level a future notifier fires on, so everything in it must be worth a phone
 *   buzzing at 2am. That constraint is what keeps the list short.
 * - `error` — a genuine server-side failure that costs a visitor the page they asked for. Worth
 *   fixing today; not worth waking anyone.
 * - `warning` — something that happened in one browser. Real, worth seeing in aggregate, and never
 *   worth an interruption on its own (see the note on client errors below).
 *
 * Deliberately NOT part of the rule: the error message. Classifying on message text means a
 * hand-maintained list of substrings that rots the first time a dependency rewords an exception,
 * and it means an attacker who can influence an error string can influence how loudly it is
 * reported. Route, status and source are all facts the server itself decided.
 */

export type ErrorSeverity = 'critical' | 'error' | 'warning';

/** Order for display and for comparisons — index 0 is the loudest. Exported so the admin tab sorts
 *  by it without restating the order and inventing a second source of truth. */
export const SEVERITY_ORDER: readonly ErrorSeverity[] = ['critical', 'error', 'warning'] as const;

/**
 * Route prefixes where a failure means money or stock, matched against the request path.
 *
 * **Prefixes, not exact paths**, so `/api/checkout` and any future `/api/checkout/anything` are
 * both covered without anyone having to remember to come back here.
 *
 * `/api/payment` is listed before it exists (GO_LIVE §3 — the provider webhook that will be the
 * only thing allowed to mark an order paid). That is the one entry here that is not backed by a
 * file today, and it is deliberate rather than speculative: the alternative is that the single most
 * money-critical route in the system is born at the wrong severity and stays there until somebody
 * notices, which is precisely the class of oversight this whole feature exists to prevent.
 *
 * `/api/seller/orders` is on the list and it is worth saying why, because it looks like ordinary
 * dashboard CRUD: an order status change is what triggers restock on cancellation and what sends
 * the buyer their "shipped" mail. A failure there leaves stock and the buyer's expectations out of
 * step with each other, which is the same class of harm as a failed charge.
 *
 * `/api/cart/prices` is NOT here. It re-computes prices server-side, so a failure is loud and
 * visible and blocks the buyer BEFORE anything is charged — bad, but recoverable by retrying, and
 * nothing is left inconsistent behind it.
 */
const MONEY_PATH_PREFIXES = [
  '/api/checkout',
  '/api/payment',
  '/api/seller/orders',
  '/checkout',
] as const;

/** Just enough of an entry to classify it — takes a shape, not the full row, so the admin page and
 *  the writer can both call it and neither has to build a whole entry to ask. */
export interface SeverityInput {
  source?: 'server' | 'client' | string;
  route?: string | null;
  statusCode?: number | null;
}

export function isMoneyPath(route: string | null | undefined): boolean {
  if (!route) return false;
  // Compare on the path only: a query string is caller-controlled and must not be able to change
  // how loudly a failure is reported.
  const path = route.split('?')[0] ?? route;
  return MONEY_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * The severity of one entry.
 *
 * **Why every client error is a warning, including the ones that are actually serious.** A JavaScript
 * error that breaks "add to cart" for every visitor matters enormously — and a single report cannot
 * be told apart from an ad-blocker, a browser three versions old, or a translation extension
 * rewriting the DOM. The thing that distinguishes a real outage is VOLUME, which one entry does not
 * carry and the Alerts tab shows plainly. Promoting client errors on route alone would page someone
 * for one visitor's browser extension, and an alert channel that cries wolf gets muted — after
 * which the genuine one is not delivered either. So the browser reports at `warning` and the server
 * is what pages.
 */
export function deriveSeverity(entry: SeverityInput): ErrorSeverity {
  if (entry.source === 'client') return 'warning';
  if (isMoneyPath(entry.route)) return 'critical';
  return 'error';
}
