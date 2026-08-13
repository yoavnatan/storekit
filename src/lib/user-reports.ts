/**
 * "דווח על תקלה" — a fault or content report a visitor writes to the platform.
 *
 * The storage decisions (why its own table and not `error_log`, why no rolling cap) are on
 * `migrations/0025_user_reports.sql`. What this file owns is the rule that makes the record worth
 * having: **the reporter describes, the SERVER attributes.** `message` and `kind` are theirs;
 * `page_url`, `store_slug`, `reporter_role` and `reporter_id` are read off the request and the
 * session, never off the body. A report that let its sender name the store it is about would be a
 * way to point the admin at a competitor.
 *
 * Identity resolution is `lib/request-actor.ts`, shared with the error log — the two lists render
 * one above the other on the admin's Alerts tab, and two different answers to "who was this" on one
 * screen is how one of them ends up wrong. The only thing added here is the third role: this table
 * records people who were never signed in, so an unresolved actor is a `guest` rather than a blank.
 */

import type { AstroCookies } from 'astro';
import { firstRow, isUuid, query, rows } from './db.js';
import { resolveRequestActor } from './request-actor.js';
import { safeRedirectPath } from './safe-redirect.js';

/** Long enough for someone to describe what happened in their own words, short enough that the
 *  column is not a place to paste a file. The form counts down against the same number. */
export const MAX_REPORT_LEN = 2000;
const MAX_EMAIL_LEN = 200;
const MAX_PATH_LEN = 500;
const MAX_UA_LEN = 300;

/** The reporter's own classification — a triage hint, not a routing decision. `migrations/0025`
 *  says why the list is this short. */
export const REPORT_KINDS = ['fault', 'content', 'store', 'other'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface UserReport {
  id: string;
  kind: ReportKind;
  message: string;
  pageUrl?: string;
  storeSlug?: string;
  reporterEmail?: string;
  reporterRole?: 'guest' | 'buyer' | 'seller';
  reporterId?: string;
  userAgent?: string;
  status: 'open' | 'handled';
  createdAt: string;
  handledAt?: string;
}

/** What the endpoint hands over: the two fields a person filled in, plus the raw request context
 *  this module is responsible for distrusting. */
export interface NewReport {
  kind: unknown;
  message: unknown;
  reporterEmail: unknown;
  /** The page the reporter was on, as the browser reported it. Validated here, not by the caller. */
  pageUrl: unknown;
  userAgent: string | null;
  cookies: AstroCookies;
}

function clamp(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizeKind(value: unknown): ReportKind {
  return (REPORT_KINDS as readonly string[]).includes(value as string) ? (value as ReportKind) : 'other';
}

/** A site-relative path or nothing. `safeRedirectPath` is the shared rule for every
 *  request-supplied destination on this platform (Hard rules → Security review gate) and it applies
 *  here for the same reason: the admin panel renders this value as a link. */
function normalizePath(value: unknown): string | null {
  const raw = clamp(value, MAX_PATH_LEN);
  return raw ? (safeRedirectPath(raw, '') || null) : null;
}

/** The third role. `request-actor.ts` leaves the field unset when nobody was signed in — correct
 *  there, where every caller is an account-shaped surface — but this table's whole point is that a
 *  guest may file a report, so "nobody" is a value here rather than an absence. */
async function resolveContext(pageUrl: string | null, cookies: AstroCookies): Promise<{
  storeSlug: string | null;
  role: 'guest' | 'buyer' | 'seller';
  actorId: string | null;
}> {
  const actor = await resolveRequestActor(pageUrl ?? '', cookies);
  return {
    storeSlug: actor.storeSlug ?? null,
    role: actor.actorRole ?? 'guest',
    actorId: actor.actorId ?? null,
  };
}

/**
 * Record one report. Returns `false` only when there is nothing to record (an empty message) —
 * a database failure throws, unlike `logError`, because here the caller CAN tell the person that
 * their report did not go through, and silently swallowing it is the one outcome worse than an
 * error message.
 */
export async function createUserReport(input: NewReport): Promise<boolean> {
  const message = clamp(input.message, MAX_REPORT_LEN);
  if (!message) return false;

  const pageUrl = normalizePath(input.pageUrl);
  const { storeSlug, role, actorId } = await resolveContext(pageUrl, input.cookies);

  await query(
    `INSERT INTO user_reports
       (kind, message, page_url, store_slug, reporter_email, reporter_role, reporter_id, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      normalizeKind(input.kind),
      message,
      pageUrl,
      storeSlug,
      clamp(input.reporterEmail, MAX_EMAIL_LEN),
      role,
      actorId,
      clamp(input.userAgent, MAX_UA_LEN),
    ],
  );
  return true;
}

interface ReportRow {
  id: string;
  kind: ReportKind;
  message: string;
  page_url: string | null;
  store_slug: string | null;
  reporter_email: string | null;
  reporter_role: 'guest' | 'buyer' | 'seller' | null;
  reporter_id: string | null;
  user_agent: string | null;
  status: 'open' | 'handled';
  created_at: string | Date;
  handled_at: string | Date | null;
}

const SELECT_REPORT = `SELECT id, kind, message, page_url, store_slug, reporter_email,
                              reporter_role, reporter_id, user_agent, status, created_at, handled_at
                         FROM user_reports`;

/** `timestamptz` comes back as a `Date` from `pg` and as a string from PGlite (§8) — the same
 *  normalisation every other read module here does, so both render identically. */
const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value);

function toReport(row: ReportRow): UserReport {
  return {
    id: row.id,
    kind: row.kind,
    message: row.message,
    pageUrl: row.page_url ?? undefined,
    storeSlug: row.store_slug ?? undefined,
    reporterEmail: row.reporter_email ?? undefined,
    reporterRole: row.reporter_role ?? undefined,
    reporterId: row.reporter_id ?? undefined,
    userAgent: row.user_agent ?? undefined,
    status: row.status,
    createdAt: iso(row.created_at),
    handledAt: row.handled_at ? iso(row.handled_at) : undefined,
  };
}

/**
 * Newest first, open ones above handled ones — the panel is a queue, so the thing still waiting
 * outranks the thing already dealt with regardless of which is newer.
 *
 * **`id` is the last key, and it is not decoration.** `created_at` defaults to `now()`, which is
 * the TRANSACTION's clock — two reports filed in the same instant carry the same timestamp, and
 * with nothing after it Postgres is free to return them in a different order on every render. A
 * queue that reshuffles on refresh is one an admin cannot work through, and it caught this file's
 * own test intermittently before it could ever have caught anyone else. The value is arbitrary; the
 * only property being bought is that it is STABLE.
 */
export async function getRecentReports(limit = 50): Promise<UserReport[]> {
  const found = await rows<ReportRow>(
    `${SELECT_REPORT} ORDER BY (status = 'open') DESC, created_at DESC, id DESC LIMIT $1`,
    [Math.max(1, Math.min(200, Math.trunc(limit) || 50))],
  );
  return found.map(toReport);
}

/** How many are still waiting. Its own query rather than a count over the page above: the panel
 *  shows a bounded list, and "3 open" must stay true past the end of it. */
export async function countOpenReports(): Promise<number> {
  const row = await firstRow<{ n: string | number }>(
    `SELECT count(*) AS n FROM user_reports WHERE status = 'open'`,
  );
  return Number(row?.n ?? 0);
}

/** Admin triage. Returns false for an id that is not a report — including one that is not a uuid at
 *  all, which Postgres would raise on rather than simply not match. */
export async function setReportHandled(id: string, handled: boolean): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await query(
    `UPDATE user_reports
        SET status = $2, handled_at = CASE WHEN $2 = 'handled' THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, handled ? 'handled' : 'open'],
  );
  return rowCount > 0;
}
