import { store as platform } from '../config/store.config.js';
import { isDemoStore } from './demo-stores.js';
import { stripTrailingSlashes } from './url-base.js';
import { outboundFetch } from './outbound-fetch.js';
import { hasActiveCustomDomain } from './custom-domain.js';
import type { Store } from './stores.js';

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
    new Set(
      paths
        .map((u) => (/^https?:\/\//i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`))
        // Percent-encode the path. Store AND product slugs carry Hebrew (url-base.ts#toSlug keeps
        // it, by the owner's decision), and this is a MACHINE surface — the same rule the sitemap's
        // <loc>, the feed's <link> and the canonical already follow. Until 2026-08-05 this was the
        // one that didn't: it string-concatenated, so a Hebrew store submitted
        // `https://dezabin.co.il/חנות-הנעליים/נעל-ריצה` raw, which is not a valid URL and which the
        // endpoint is entitled to reject — taking the whole batch with it, silently, since the
        // submit is fire-and-forget. Invisible on the seed catalog, whose slugs are all latin.
        //
        // The URL constructor rather than urlSegment() per segment, precisely because it is
        // IDEMPOTENT: it leaves an already-encoded `%D7%97` alone, while re-encoding a segment
        // would turn it into `%25D7%2597`. A caller passing an encoded path is a question this
        // then never has to ask.
        .map((u) => {
          try { return new URL(u).href; } catch { return null; }
        })
        .filter((u): u is string => !!u),
    ),
  ).slice(0, MAX_URLS);
  return { host, key: cfg.key, keyLocation: `${base}/${cfg.key}.txt`, urlList: abs };
}

/**
 * Fire-and-forget submit. No-op when disabled (dev / placeholder domain / no key); swallows every
 * error — indexing must never break or slow a mutation.
 *
 * `siteUrl` is the host these URLs live on, and it is a parameter because a store on its own domain
 * publishes URLs on THAT host: IndexNow verifies one submission against one host, so the `host` and
 * the `keyLocation` in the payload have to be the store's, not ours, or the batch is rejected whole.
 * The key file answers there too — `/<key>.txt` carries an extension, so the custom-domain rewrite
 * passes it straight through to the same route that serves it on the platform.
 *
 * Submitting the platform URL instead would not have failed loudly; it would have handed Bing a 301
 * per product and let the store's real URLs be found second-hand. Bing is the index ChatGPT and
 * Copilot retrieve from, which is the whole reason this file exists.
 */
export async function pingIndexNow(paths: string[], siteUrl: string = platform.url): Promise<void> {
  try {
    const cfg: IndexNowConfig = { key: platform.seo?.indexNowKey, siteUrl };
    if (!paths.length || !indexNowEnabled(cfg)) return;
    const payload = buildIndexNowPayload(paths, { key: cfg.key!.trim(), siteUrl: cfg.siteUrl });
    if (!payload.urlList.length) return;
    await outboundFetch(INDEXNOW_ENDPOINT, {
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
export type PingTarget = Pick<Store, 'slug' | 'customDomain'> & { demo?: boolean };

/**
 * Where this store's URLs actually live, and what to prefix a path with there.
 *
 * On its own verified domain the store IS the site root, so its product is `/<product>`; on the
 * platform it is `/<slug>/<product>`. Same split the sitemap makes, from the same one helper, so
 * the two surfaces cannot drift into naming a store's pages differently.
 */
function pingBase(store: PingTarget): { siteUrl: string; prefix: string } {
  return hasActiveCustomDomain(store)
    ? { siteUrl: `https://${store.customDomain!.hostname}`, prefix: '' }
    : { siteUrl: platform.url, prefix: `/${store.slug}` };
}

/** Convenience: notify of a changed product page (and its store page, whose
 *  listing the change also affects). No-op for a showcase store. */
export function pingProductChange(store: PingTarget | undefined, productSlug: string): void {
  // `undefined` is accepted rather than assumed away, and this is not defensive noise. Every call
  // site reaches the store with `stores.find(...)!` after an ownership guard, so it cannot be
  // undefined today — but the ping runs AFTER the write, and `isDemoStore` reads `.demo`
  // synchronously, OUTSIDE pingIndexNow's try/catch. So the day a guard above one of those call
  // sites moves, a successful delete answers 500. This file's contract is that indexing never
  // breaks a mutation; that has to hold for the synchronous half too.
  if (!store || isDemoStore(store)) return;
  const { siteUrl, prefix } = pingBase(store);
  void pingIndexNow([`${prefix}/${productSlug}`, prefix || '/'], siteUrl);
}

/**
 * Several products of one store changed at once — a bulk discount, a CSV import, a bulk delete.
 *
 * ONE submission carrying every URL, not N calls: the protocol takes a list precisely so a
 * catalog-wide change is a single request, and looping `pingProductChange` would fire a fetch per
 * product (a 500-row import becoming 500 POSTs is how a best-effort ping turns into rate-limiting).
 * The store page is included once at the end for the same reason it rides along on a single-product
 * ping — its listing changed too.
 */
export function pingProductsChanged(store: PingTarget | undefined, productSlugs: readonly string[]): void {
  if (!store || isDemoStore(store) || !productSlugs.length) return;
  const { siteUrl, prefix } = pingBase(store);
  const paths = productSlugs.map((slug) => `${prefix}/${slug}`);
  void pingIndexNow([...paths, prefix || '/'], siteUrl);
}

/** Convenience: notify of a changed store page. No-op for a showcase store. */
export function pingStoreChange(store: PingTarget): void {
  if (isDemoStore(store)) return;
  const { siteUrl, prefix } = pingBase(store);
  void pingIndexNow([prefix || '/'], siteUrl);
}
