import { store as platform } from '../config/store.config.js';
import { isDemoStore } from './demo-stores.js';
import { stripTrailingSlashes } from './url-base.js';

// IndexNow — the one ACTIVE indexing lever (vs. passively waiting for a crawl).
// When a store/product page is newly published or its indexability changes, we
// push the URL straight to the IndexNow endpoint. Bing, Yandex and others share
// one submission, and — crucially for AIO — Bing's index is what ChatGPT /
// Copilot retrieve from, so a fresh product can surface in AI answers within
// minutes instead of waiting days for an organic crawl.
//
// Best-effort by design: indexing is never on the critical path of a mutation.
// Every entry point is a no-op unless a key is configured AND the domain is real
// (a placeholder example.com submission would just be rejected). Callers
// fire-and-forget — `void pingIndexNow([...])` — and nothing here throws.

const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_URLS = 10_000; // IndexNow per-request cap

export function isPlaceholderHost(url: string): boolean {
  try {
    return /(^|\.)example\.(com|org|net)$/i.test(new URL(url).hostname);
  } catch {
    return true; // an unparseable/relative url is never a real, submittable host
  }
}

export interface IndexNowConfig {
  key?: string | null;
  siteUrl: string;
}

/** Usable only when a key is set AND the site is on a real (non-placeholder) domain. */
export function indexNowEnabled(cfg: IndexNowConfig): boolean {
  return Boolean(cfg.key && cfg.key.trim()) && !isPlaceholderHost(cfg.siteUrl);
}

export interface IndexNowPayload {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

/** Build the IndexNow POST body: absolutize + dedupe the paths, attach the key
 *  and its verification-file location. Accepts relative ('/x') or absolute URLs. */
export function buildIndexNowPayload(paths: string[], cfg: { key: string; siteUrl: string }): IndexNowPayload {
  const base = stripTrailingSlashes(cfg.siteUrl);
  const host = new URL(base).hostname;
  const abs = Array.from(
    new Set(paths.map((u) => (/^https?:\/\//i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`))),
  ).slice(0, MAX_URLS);
  return { host, key: cfg.key, keyLocation: `${base}/${cfg.key}.txt`, urlList: abs };
}

/** Fire-and-forget submit. No-op when disabled (dev / placeholder domain / no
 *  key); swallows every error — indexing must never break or slow a mutation. */
export async function pingIndexNow(paths: string[]): Promise<void> {
  try {
    const cfg: IndexNowConfig = { key: platform.seo?.indexNowKey, siteUrl: platform.url };
    if (!paths.length || !indexNowEnabled(cfg)) return;
    const payload = buildIndexNowPayload(paths, { key: cfg.key!.trim(), siteUrl: cfg.siteUrl });
    if (!payload.urlList.length) return;
    await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
  } catch {
    // best-effort; not critical-path
  }
}

/** The store a ping is about. Taken as an object rather than a bare slug so the
 *  demo check below can't be forgotten at a call site — pushing a showcase store
 *  (lib/demo-stores.ts) to Bing would put fabricated catalog straight into the
 *  index that feeds ChatGPT/Copilot, which is the exact opposite of the point. */
export type PingTarget = { slug: string; demo?: boolean };

/** Convenience: notify of a changed product page (and its store page, whose
 *  listing the change also affects). No-op for a showcase store. */
export function pingProductChange(store: PingTarget, productSlug: string): void {
  if (isDemoStore(store)) return;
  void pingIndexNow([`/${store.slug}/${productSlug}`, `/${store.slug}`]);
}

/** Convenience: notify of a changed store page. No-op for a showcase store. */
export function pingStoreChange(store: PingTarget): void {
  if (isDemoStore(store)) return;
  void pingIndexNow([`/${store.slug}`]);
}
