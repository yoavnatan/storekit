import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import { getSellerSession, getSellerById } from './seller-auth.js';
import { getStoreBySellerId, getStoreBySlug } from './stores.js';

const ERROR_LOG_PATH = path.join(process.cwd(), 'data/error-log.json');
const MAX_ENTRIES = 500;

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
}

// Best-effort identity for an error entry: derives the store from a
// `/store/[slug]` route and the signed-in account (buyer or seller share the
// same session cookie — an account only counts as 'seller' if it owns a
// store). Callers with more specific context (e.g. checkout, which already
// knows the buyer email) should build these fields directly instead.
// Called from a catch block building logError's own arguments (i.e. before
// logError's internal try/catch even starts) — so this one, unlike logError,
// has to guarantee it never throws by itself rather than relying on a
// caller to wrap it.
export function resolveErrorContext(
  pathname: string,
  cookies: AstroCookies
): Pick<ErrorLogEntry, 'storeSlug' | 'storeName' | 'actorRole' | 'actorId' | 'actorLabel'> {
  const ctx: Pick<ErrorLogEntry, 'storeSlug' | 'storeName' | 'actorRole' | 'actorId' | 'actorLabel'> = {};
  try {
    const storeMatch = pathname.match(/^\/store\/([^/]+)/);
    if (storeMatch?.[1]) {
      const store = getStoreBySlug(storeMatch[1]);
      if (store) { ctx.storeSlug = store.slug; ctx.storeName = store.name; }
    }

    const accountId = getSellerSession(cookies);
    if (accountId) {
      const account = getSellerById(accountId);
      if (account) {
        const ownStore = getStoreBySellerId(accountId);
        ctx.actorId = accountId;
        ctx.actorLabel = account.email;
        ctx.actorRole = ownStore ? 'seller' : 'buyer';
        if (ownStore && !ctx.storeSlug) { ctx.storeSlug = ownStore.slug; ctx.storeName = ownStore.name; }
      }
    }
  } catch { /* best-effort — never throw from inside an error handler's own context-gathering */ }

  return ctx;
}

function readErrorLog(): ErrorLogEntry[] {
  try { return JSON.parse(fs.readFileSync(ERROR_LOG_PATH, 'utf8')) as ErrorLogEntry[]; }
  catch { return []; }
}

function writeErrorLog(entries: ErrorLogEntry[]): void {
  fs.writeFileSync(ERROR_LOG_PATH, JSON.stringify(entries, null, 2));
}

export function truncateStack(stack: string, max = 2000): string {
  return stack.length > max ? stack.slice(0, max) + '…' : stack;
}

// Fire-and-forget by design: a logging failure must never break the request
// that triggered it, so every error here is swallowed rather than thrown.
export function logError(entry: Omit<ErrorLogEntry, 'id' | 'createdAt'>): void {
  try {
    const entries = readErrorLog();
    entries.push({
      ...entry,
      stack: entry.stack ? truncateStack(entry.stack) : undefined,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    // Cap the file so a noisy repeating error can't grow it unbounded —
    // drop the oldest entries first, keep the most recent MAX_ENTRIES.
    writeErrorLog(entries.slice(-MAX_ENTRIES));
  } catch { /* logging must never itself throw */ }
}

export function getRecentErrors(limit = 100): ErrorLogEntry[] {
  return readErrorLog()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

export function clearErrorLog(): void {
  writeErrorLog([]);
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
