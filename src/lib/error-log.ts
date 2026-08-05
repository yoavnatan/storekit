import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import { isUuid, query } from './db.js';
import { getSellerSession, getSellerById } from './seller-auth.js';
import { getStoreBySellerId, getStoreBySlug } from './stores.js';

/**
 * The admin Alerts tab's log — every 500 the middleware caught and every client-side JS error a
 * page reported.
 *
 * **Moved to Postgres (DB_MIGRATION_PLAN.md §8, the last of "the rest").** Two decisions shaped
 * this file, and neither of them is about SQL.
 *
 * **1. Writing is fire-and-forget, and it gives up rather than waits.** `logError` runs inside the
 * error handler itself (`middleware.ts` catches every 500 and calls it), so the thing being logged
 * is quite often the database. Waiting there buys nothing — nobody reads the return value, and the
 * write we would be waiting for is going to fail for the same reason the request did — while
 * costing the one scarce resource: with `DB_POOL_MAX` connections in the pool (10 by default) and
 * a database that is down, EVERY request becomes a 500, so every request would sit in this handler
 * holding a pooled connection for up to `connectionTimeoutMillis` + `statement_timeout`. A database
 * outage would turn itself into a total freeze of the site. So: `logError` never rejects, every
 * call site is `void logError(…)`, and `MAX_CONCURRENT_WRITES` caps how much of the pool this
 * module can hold at once no matter how fast errors arrive. Past the cap an entry is DROPPED, not
 * queued — and it still reaches `console.error`, which is where an external monitor
 * (CURRENT_TASK.md → סשן ג׳: Sentry/Logtail) reads from anyway. A timeout would not do this job:
 * `Promise.race` abandons the promise while the query keeps holding the connection.
 *
 * **2. `MAX_ENTRIES` is still a hard ceiling, and it is still 500.** In the file era `slice(-500)`
 * on every write meant the log physically could not exceed 500 entries. A `LIMIT` on the read side
 * means something completely different — it bounds what the admin sees, not what the table costs —
 * and `POST /api/log-client-error` is unauthenticated and unrated, i.e. the one write path in this
 * application that anyone at all may call for free. So the cap is enforced in the write statement.
 * It stays at 500 because `admin/index.astro` derives the store-filter dropdown
 * (`getErrorStoreNames`) and the "(N) new since last opened" badge (`countSince`) from the array
 * `getRecentErrors(MAX_ENTRIES)` returns: at this cap that array IS the whole log and both are
 * exact. Raising the number silently turns both into "over the newest N" — so raising it means
 * moving those two into queries of their own first.
 */

/** The hard ceiling on stored entries — see the module note. Exported so the admin page reads
 *  "all of them" from the number itself instead of restating it in a comment. */
export const MAX_ENTRIES = 500;

/**
 * How many log writes may hold a pooled connection at once. Two, because this runs in the error
 * handler: the point is that a storm of 500s cannot drain the pool that the healthy requests need.
 */
const MAX_CONCURRENT_WRITES = 2;

/**
 * A ceiling on how many CLIENT-sourced entries may be written per minute, per process.
 *
 * **Why client entries specifically.** `MAX_CONCURRENT_WRITES` bounds how much of the pool this
 * module holds at one instant; it does not bound the RATE, so a caller sending reports back-to-back
 * keeps two connections busy indefinitely and writes forever. For server entries that is the
 * correct trade — a storm of 500s is exactly what you want recorded, and only our own code can
 * produce one. `POST /api/log-client-error` is different in kind: it is unauthenticated and
 * unrated, the one write path in this application that any stranger may call for free, and each
 * call costs up to three identity lookups plus an insert-and-prune. The reporter in the browser
 * caps itself at five per page load, which is a real defence against a runaway loop in our own
 * JavaScript and no defence at all against someone who is not using a browser.
 *
 * **Why sixty, and why dropping is not a loss.** `MAX_ENTRIES` is 500, so at this rate a genuine
 * incident — a deploy that breaks the same script for every visitor — still fills the entire
 * visible log in under nine minutes. Past that point the 501st report only pushes out the 500th;
 * it buys no information and costs a write. What it buys an attacker is table churn, so the cap
 * is what makes the two cases diverge.
 *
 * A fixed window, not a rolling one, and per process rather than in Postgres: this exists to keep
 * cost off the database, so spending a database round trip to decide whether to spend a database
 * round trip would defeat it. A second instance getting its own budget is the correct behaviour —
 * it is the pool of that instance being protected.
 */
const MAX_CLIENT_WRITES_PER_WINDOW = 60;
const CLIENT_WINDOW_MS = 60_000;

let clientWindowStart = 0;
let clientWritesInWindow = 0;

/** Whether a client-sourced entry may be written now. Advances the window as a side effect. */
function clientBudgetAllows(): boolean {
  const now = Date.now();
  if (now - clientWindowStart >= CLIENT_WINDOW_MS) {
    clientWindowStart = now;
    clientWritesInWindow = 0;
  }
  if (clientWritesInWindow >= MAX_CLIENT_WRITES_PER_WINDOW) return false;
  clientWritesInWindow++;
  return true;
}

/** Test seam — the window is module state, and a test asserting the cap must not inherit the
 *  counter left behind by the one before it. */
export function resetClientWriteBudget(): void {
  clientWindowStart = 0;
  clientWritesInWindow = 0;
}

/**
 * Length ceilings, applied here rather than trusted from the call site.
 *
 * `message` had no limit in the code and has none in the column — and in `middleware.ts` it is
 * `err.message`, which can carry request input (a Postgres error quotes the value it rejected).
 * This is not the btree-2704 trap (§8, user-carts): none of these columns is indexed. It is
 * unbounded growth from an unauthenticated sender, one row at a time.
 */
const MAX_MESSAGE_LEN = 500;
const MAX_STACK_LEN = 2000;
const MAX_ROUTE_LEN = 200;
const MAX_LABEL_LEN = 200;
const MAX_HINT_LEN = 500;

export interface ErrorLogEntry {
  id: string;
  source: 'server' | 'client';
  route?: string;
  message: string;
  stack?: string;
  statusCode?: number;
  createdAt: string;
  // Who/where this happened to — best-effort, not always resolvable (e.g. an
  // anonymous visitor or a route with no store in its path leaves these unset).
  storeSlug?: string;
  storeName?: string;
  actorRole?: 'buyer' | 'seller';
  actorId?: string;
  actorLabel?: string; // email, for admin display
  // Automation groundwork: a human-readable "how to resolve" message, set by
  // the call site when the failure mode is known — not sent anywhere yet,
  // just carried on the entry so a future notifier can relay it as-is.
  resolutionHint?: string;
  // Manual admin triage — the log itself stays otherwise read-only/automatic
  // (see clearErrorLog), this is the one deliberate human-toggled field.
  resolved?: boolean;
}

/** What `logError` needs in order to work out who this happened to, when the caller does not
 *  already know. Passed rather than resolved by the caller so the queries it costs happen INSIDE
 *  the fire-and-forget, concurrency-capped write — see the module note. */
export interface ErrorContextSource {
  pathname: string;
  cookies: AstroCookies;
}

export function truncateStack(stack: string, max = MAX_STACK_LEN): string {
  return stack.length > max ? stack.slice(0, max) + '…' : stack;
}

function clamp(value: string | undefined, max: number): string | null {
  if (typeof value !== 'string' || !value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * The CHECK constraints are `source IN ('server','client')` and `actor_role IN ('buyer','seller')`,
 * and a violated CHECK raises — inside the error handler, which is the worst place in the
 * application for a second error. Every call site passes a literal today (verified, all nine), so
 * this is not a live bug; it is the gate that keeps it from becoming one when a tenth is added.
 */
function normalizeSource(value: unknown): 'server' | 'client' {
  return value === 'client' ? 'client' : 'server';
}

function normalizeRole(value: unknown): 'buyer' | 'seller' | null {
  return value === 'buyer' || value === 'seller' ? value : null;
}

/** `status_code` is an `integer` column and the value is an HTTP status; anything outside that
 *  range is not a status, and `1e30` is `value out of range` rather than a big number (§8). */
function normalizeStatus(value: unknown): number | null {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 100 && n <= 599 ? n : null;
}

// Best-effort identity for an error entry: derives the store from a
// root-level `/<slug>` route and the signed-in account (buyer or seller share the
// same session cookie — an account only counts as 'seller' if it owns a
// store). Callers with more specific context (e.g. checkout, which already
// knows the buyer email) build these fields directly instead, and what they
// pass wins over what this resolves.
// Runs inside logError's own try/catch now, but keeps its own as well: it is three queries on the
// error path, and a rejection here must not skip the insert that is the whole point.
async function resolveErrorContext(
  pathname: string,
  cookies: AstroCookies
): Promise<Pick<ErrorLogEntry, 'storeSlug' | 'storeName' | 'actorRole' | 'actorId' | 'actorLabel'>> {
  const ctx: Pick<ErrorLogEntry, 'storeSlug' | 'storeName' | 'actorRole' | 'actorId' | 'actorLabel'> = {};
  try {
    // Stores live at the root (/<slug>, /<slug>/<product>). Take the first path segment and let
    // getStoreBySlug filter — a non-store route (/checkout, /search, …) simply returns null.
    const storeMatch = pathname.match(/^\/([^/]+)(?:\/|$)/);
    if (storeMatch?.[1]) {
      const store = await getStoreBySlug(storeMatch[1]);
      if (store) { ctx.storeSlug = store.slug; ctx.storeName = store.name; }
    }

    const accountId = getSellerSession(cookies);
    if (accountId) {
      const account = await getSellerById(accountId);
      if (account) {
        const ownStore = await getStoreBySellerId(accountId);
        ctx.actorId = accountId;
        ctx.actorLabel = account.email;
        ctx.actorRole = ownStore ? 'seller' : 'buyer';
        if (ownStore && !ctx.storeSlug) { ctx.storeSlug = ownStore.slug; ctx.storeName = ownStore.name; }
      }
    }
  } catch { /* best-effort — never throw from inside an error handler's own context-gathering */ }

  return ctx;
}

/** How many writes are holding a pooled connection right now. Module state on purpose: the thing
 *  being protected (the pool) is per-process too. */
let inFlight = 0;

/**
 * Record one error. Never throws, never rejects, and is meant to be called as `void logError(…)`.
 *
 * The `void` is not a style choice — see the module note. It is what keeps a failed log line from
 * turning an already-charged checkout into a 500 (the lesson from the messages diff), and what
 * keeps the error handler from waiting on the database that is probably the reason it ran.
 */
export async function logError(
  entry: Omit<ErrorLogEntry, 'id' | 'createdAt'>,
  context?: ErrorContextSource,
): Promise<void> {
  if (inFlight >= MAX_CONCURRENT_WRITES) {
    // Dropped, not queued — but not lost: stderr is where an external monitor reads from.
    console.error('[error-log] dropped (busy):', entry.message);
    return;
  }
  // Checked before the identity lookup below, not after: those are the three queries the cap
  // exists to prevent a stranger from buying, so paying them to decide whether to skip the fourth
  // would leave most of the cost in place.
  if (normalizeSource(entry.source) === 'client' && !clientBudgetAllows()) {
    console.error('[error-log] dropped (client rate cap):', entry.message);
    return;
  }
  inFlight++;
  try {
    const ctx = context ? await resolveErrorContext(context.pathname, context.cookies) : {};
    // The caller's own fields win — it knows more than a path segment does — so the resolved
    // context only fills what was left unset.
    const merged = { ...ctx, ...definedOnly(entry) };

    await query(
      // One statement: insert the entry and enforce the ceiling, both on `error_log_seq_idx`.
      //
      // The ceiling prunes by `seq`, NOT by `created_at` — see migrations/0005. A timestamp's
      // resolution is finite, three entries can share one, and the tie-break behind them is a
      // random uuid: "the oldest" would then be arbitrary inside a burst, which is precisely when
      // this DELETE runs.
      //
      // `OFFSET $13` is `MAX_ENTRIES - 1` and not `MAX_ENTRIES`: every part of a data-modifying CTE
      // sees the SAME snapshot, so the DELETE cannot see the row the INSERT beside it is writing.
      // Trimming to one below the cap on the pre-insert table leaves exactly the cap afterwards.
      `WITH ins AS (
         INSERT INTO error_log (
           id, source, route, message, stack, status_code, store_slug, store_name,
           actor_role, actor_id, actor_label, resolution_hint, resolved, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, now())
       )
       DELETE FROM error_log WHERE seq IN (
         SELECT seq FROM error_log ORDER BY seq DESC OFFSET $13
       )`,
      [
        crypto.randomUUID(),
        normalizeSource(merged.source),
        clamp(merged.route, MAX_ROUTE_LEN),
        clamp(merged.message, MAX_MESSAGE_LEN) ?? '',
        merged.stack ? truncateStack(merged.stack) : null,
        normalizeStatus(merged.statusCode),
        clamp(merged.storeSlug, MAX_LABEL_LEN),
        clamp(merged.storeName, MAX_LABEL_LEN),
        normalizeRole(merged.actorRole),
        clamp(merged.actorId, MAX_LABEL_LEN),
        clamp(merged.actorLabel, MAX_LABEL_LEN),
        clamp(merged.resolutionHint, MAX_HINT_LEN),
        MAX_ENTRIES - 1,
      ],
    );
  } catch (err) {
    // Logging must never itself throw — but a swallowed failure used to leave no trace at all.
    console.error('[error-log] write failed:', err instanceof Error ? err.message : String(err), '|', entry.message);
  } finally {
    inFlight--;
  }
}

/** Spreading an object with explicit `undefined` values would blank the resolved context under
 *  them, which is the opposite of "the caller's fields win". */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

interface ErrorRow {
  id: string;
  source: 'server' | 'client';
  route: string | null;
  message: string;
  stack: string | null;
  status_code: number | null;
  store_slug: string | null;
  store_name: string | null;
  actor_role: 'buyer' | 'seller' | null;
  actor_id: string | null;
  actor_label: string | null;
  resolution_hint: string | null;
  resolved: boolean;
  created_at: Date | string;
}

/** A NULL column is an ABSENT field, not an empty one — every consumer of `ErrorLogEntry` tests
 *  these with `?.`/`??`, and `storeSlug: null` would defeat that. */
function toEntry(row: ErrorRow): ErrorLogEntry {
  return {
    id: row.id,
    source: row.source,
    message: row.message,
    createdAt: new Date(row.created_at).toISOString(),
    resolved: row.resolved,
    ...(row.route ? { route: row.route } : {}),
    ...(row.stack ? { stack: row.stack } : {}),
    ...(row.status_code !== null ? { statusCode: row.status_code } : {}),
    ...(row.store_slug ? { storeSlug: row.store_slug } : {}),
    ...(row.store_name ? { storeName: row.store_name } : {}),
    ...(row.actor_role ? { actorRole: row.actor_role } : {}),
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    ...(row.actor_label ? { actorLabel: row.actor_label } : {}),
    ...(row.resolution_hint ? { resolutionHint: row.resolution_hint } : {}),
  };
}

/**
 * Newest first — the order `filterAndSortErrors` below is documented to receive.
 *
 * By `seq`, which is arrival, and not by `created_at`, which is a clock (migrations/0005). Both say
 * the same thing whenever the clock can tell two entries apart; when it cannot — a burst, i.e. the
 * case a triage screen exists for — only `seq` still does. The sort is `error_log_seq_idx` rather
 * than a pass in JS.
 */
export async function getRecentErrors(limit = 100): Promise<ErrorLogEntry[]> {
  const { rows } = await query<ErrorRow>(
    `SELECT id, source, route, message, stack, status_code, store_slug, store_name,
            actor_role, actor_id, actor_label, resolution_hint, resolved, created_at
       FROM error_log
      ORDER BY seq DESC
      LIMIT $1`,
    [Math.max(0, Math.trunc(Number(limit)) || 0)],
  );
  return rows.map(toEntry);
}

export async function clearErrorLog(): Promise<void> {
  await query('DELETE FROM error_log');
}

/**
 * The one deliberately human-toggled field. Returns whether a row was actually changed — the API
 * route turns `false` into a 404, so the affected-row count IS the verdict (§7.5).
 *
 * `isUuid` first because the id arrives in a request body, and Postgres REJECTS a malformed uuid
 * literal rather than failing to match it: without this, `{"id":"nope"}` is a 500 instead of a 404.
 */
export async function setErrorResolved(id: string, resolved: boolean): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await query('UPDATE error_log SET resolved = $2 WHERE id = $1', [id, resolved]);
  return rowCount > 0;
}

// Admin Alerts tab's own filter/sort — mirrors admin-orders-filter.ts's
// filterAndSortOrders (pure, runs over the full already-sorted-desc entry
// list from getRecentErrors before pagination slices it).
export type AlertsSortDir = 'asc' | 'desc';

export interface AlertsQuery {
  sortDir: AlertsSortDir;
  source: string[]; // 'server' | 'client'
  storeSlug: string[];
}

export function filterAndSortErrors(entries: ErrorLogEntry[], query: AlertsQuery): ErrorLogEntry[] {
  const sourceSet = query.source.length ? new Set(query.source) : null;
  const storeSet = query.storeSlug.length ? new Set(query.storeSlug) : null;

  const filtered = entries.filter((e) => {
    if (sourceSet && !sourceSet.has(e.source)) return false;
    if (storeSet && (!e.storeSlug || !storeSet.has(e.storeSlug))) return false;
    return true;
  });

  if (query.sortDir === 'asc') {
    return [...filtered].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }
  return filtered; // already desc from getRecentErrors
}

// Every distinct store name that appears in the (unfiltered) error log — the
// store-filter dropdown needs the full set regardless of the current page,
// same reasoning as admin-orders-filter.ts's getOrderStoreNames.
export function getErrorStoreNames(entries: ErrorLogEntry[]): { slug: string; name: string }[] {
  const bySlug = new Map<string, string>();
  for (const e of entries) {
    if (e.storeSlug && !bySlug.has(e.storeSlug)) bySlug.set(e.storeSlug, e.storeName ?? e.storeSlug);
  }
  return [...bySlug.entries()].map(([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name, 'he'));
}
