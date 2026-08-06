// Custom domains (Cloudflare-for-SaaS) — the seam that lets a seller point their OWN domain
// (shop.mybrand.co.il) at their store, served from its root. Origin-agnostic and provider-agnostic:
// the app depends only on the CustomHostnameProvider contract below, never on Cloudflare's SDK —
// same black-box discipline as the email/DB adapters. A safe console STUB runs in dev/CI (no
// account, no secrets); the real Cloudflare adapter activates only when its credentials are present.
//
// The local path /<slug> is ALWAYS live and keeps working. When a custom domain is verified it
// becomes the store's SEO canonical (see storeCanonicalUrl); until then the platform path stays
// canonical. Either way both resolve to one canonical, so no duplicate content — and the store can
// never go offline if the custom domain's DNS/SSL lapses.

import { store as platform } from '../config/store.config.js';
import { machineUrl, urlSegment } from './url-base.js';
import { isReservedSlug, type Store } from './stores.js';
import { createCloudflareProvider } from './custom-domain-cloudflare.js';
import { serverEnv } from './runtime-env.js';

export type CustomDomainStatus = 'pending' | 'active';

/**
 * What a verification check can answer — and `'unknown'` is the load-bearing member.
 *
 * A check has two failure modes that look identical from outside and must never be treated alike:
 * the provider says "this hostname is not verified", and the provider could not be reached. Every
 * method of the Cloudflare adapter swallows its errors by contract (a hiccup must not break the
 * seller's dashboard), so an unreachable API used to surface as plain `'pending'`. That is harmless
 * for a seller pressing a button — and catastrophic for the periodic re-check job behind it, which
 * would read one expired API token as "every seller unpointed their DNS at the same moment" and
 * take every custom-domain store off its own domain.
 *
 * `'unknown'` is therefore never written to a store: it means *ask again later*, and the caller
 * leaves the record exactly as it found it.
 */
export type CustomDomainCheck = CustomDomainStatus | 'unknown';

/** The DNS records the seller must add at their own registrar for verification + SSL issuance. */
export interface CustomDomainVerification {
  /** CNAME record value — the seller points their host's CNAME here. */
  cnameTarget: string;
  /** Optional ownership TXT record some providers require before issuing the certificate. */
  txtName?: string;
  txtValue?: string;
}

export interface CustomHostnameProvider {
  readonly name: string;
  /** Register a hostname for edge routing + SSL. Returns the DNS records the seller must set. */
  register(hostname: string): Promise<{ ok: boolean; verification: CustomDomainVerification; error?: string }>;
  /** Poll current verification: 'active' once DNS has propagated AND the certificate is issued,
   *  'pending' when the provider positively says it is not, and 'unknown' when the provider could
   *  not be asked at all (see CustomDomainCheck — the distinction is not cosmetic). */
  checkStatus(hostname: string): Promise<{ status: CustomDomainCheck }>;
  /** De-register a hostname (seller removed it). Best-effort — never throws. */
  remove(hostname: string): Promise<void>;
}

// A public hostname: 1–253 chars, ≥2 dot-separated labels, each 1–63 chars, no leading/trailing
// hyphen. Deliberately strict — this value gets stored and matched against the request Host, so a
// malformed one must be rejected up front rather than silently never matching.
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** The CNAME target sellers point their domain at. In production this is the Cloudflare-for-SaaS
 *  fallback origin (set via env, see GO_LIVE §1); in dev it falls back to the platform hostname so
 *  the settings screen always shows a concrete, copyable instruction. */
export function cnameTarget(): string {
  const configured = serverEnv('CUSTOM_DOMAIN_TARGET');
  if (configured && configured.trim()) return configured.trim();
  return new URL(platform.url).hostname;
}

/** Lowercase + strip scheme/path/port, then validate. Returns the clean hostname or null if it
 *  isn't a usable public host. SECURITY: a seller can never claim the platform's own domain (or a
 *  subdomain of it) — that would let a custom-domain record hijack the platform's routing. */
export function normalizeHostname(input: string): string | null {
  let h = input.trim().toLowerCase();
  if (!h) return null;
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!HOSTNAME_RE.test(h)) return null;
  const platformHost = new URL(platform.url).hostname.replace(/^www\./, '');
  if (h === platformHost || h === `www.${platformHost}` || h.endsWith(`.${platformHost}`)) return null;
  return h;
}

/** Maps an inbound path on an active custom domain to the internal store path Astro should render,
 *  or null to pass the request through untouched. Stores live at the platform ROOT (/<slug>,
 *  /<slug>/<product>), so a custom domain simply prefixes the store's own slug. Pure + total so it's
 *  unit-testable and the middleware stays a thin wrapper:
 *    "/"            → "/<slug>"            (root = the store home)
 *    "/<product>"   → "/<slug>/<product>"  (pretty product URL)
 *    everything else (assets, /api, reserved routes, deep paths) → null (pass through). */
export function resolveCustomDomainRewrite(slug: string, pathname: string): string | null {
  if (pathname === '/' || pathname === '') return `/${slug}`;
  const m = pathname.match(/^\/([^/]+)\/?$/);
  if (!m) return null;                       // deeper path — already routable or not ours
  const seg = m[1]!;
  // CRITICAL: Astro re-runs middleware on the rewritten request, so `/` → `/<slug>` comes back
  // through here as `/<slug>`. Without this guard it would be re-read as a product (`/<slug>/<slug>`)
  // and loop. The store's own slug IS the internal store-home path → pass it through untouched.
  if (seg === slug) return null;
  if (seg.includes('.')) return null;        // has an extension → asset / .txt / .xml — pass through
  if (isReservedSlug(seg)) return null;      // a real top-level platform route — pass through
  return `/${slug}/${seg}`;
}

/** True once the store's own domain is verified and therefore the store's primary public home. */
export function hasActiveCustomDomain(store: Pick<Store, 'customDomain'>): boolean {
  return store.customDomain?.status === 'active';
}

/** The canonical (SEO-primary) URL for a store home. When the seller has activated their own
 *  domain, THAT domain becomes the canonical — Google credits the seller's domain, not the
 *  platform (chosen 2026-07-26). On the platform the store still lives at /<slug> and stays fully
 *  reachable, but its canonical points to the custom domain's root, so the two never compete as
 *  duplicate content. No active domain → the platform path is the canonical. */
export function storeCanonicalUrl(store: Pick<Store, 'slug' | 'customDomain'>): string {
  if (hasActiveCustomDomain(store)) return `https://${store.customDomain!.hostname}`;
  return `${platform.url}/${urlSegment(store.slug)}`;
}

/** The canonical URL for a product page — the custom-domain-served product lives at /<productSlug>
 *  (root-relative, no store slug), matching how the middleware serves a custom host. */
export function productCanonicalUrl(store: Pick<Store, 'slug' | 'customDomain'>, productSlug: string): string {
  // Per-segment encoding — a product slug is Hebrew for most of this catalogue, and a canonical
  // that differs from the URL Google actually fetched points at a different page than the one it
  // sits on (url-base.ts#urlSegment).
  if (hasActiveCustomDomain(store)) return `https://${store.customDomain!.hostname}/${urlSegment(productSlug)}`;
  return `${platform.url}/${urlSegment(store.slug)}/${urlSegment(productSlug)}`;
}

/**
 * The query marker that says "this landing was published by the platform's OWN ads".
 *
 * **Why a marker exists at all (decided 2026-08-06).** The platform advertises every seller from ONE
 * Merchant Center, ONE Catalog and ONE Pixel — that single-account model is the reason a seller can
 * be advertised without registering anywhere, and it is not negotiable. But both networks tie an ad
 * to a domain the ACCOUNT has proven it owns: Merchant Center serves items only for a claimed
 * website, and Meta needs the link's domain verified in its Business account. We can claim
 * `dezabin.co.il`. We cannot claim a thousand sellers' domains, and neither can they — the
 * verification is done from the advertiser's account, not the site's.
 *
 * So an ad landing must be a URL on the platform domain that does NOT bounce off it. Both halves
 * matter, and the second is where this used to break: the platform product URL 301s to the seller's
 * domain (see `customDomainRedirectUrl`), so a feed pointing at it handed Google a cross-domain
 * redirect — the same disapproval, one step later. `adLandingUrl` publishes the platform URL with
 * this marker, and the two store pages skip their redirect when they see it. The redirect is
 * untouched for every other visitor, so the seller's domain keeps the whole of the store's SEO —
 * which is what the 301 was built for and what an ad click was never contributing to anyway.
 */
export const AD_LANDING_PARAM = 'ad';

/** True when this URL carries the marker. Pure, so the rule is testable on its own — but a page
 *  wants `isPlatformAdLanding`, which is this plus the two conditions that make it MEAN anything. */
export function isAdLanding(url: URL): boolean {
  return url.searchParams.get(AD_LANDING_PARAM) === '1';
}

/**
 * The question a store page actually asks: *is this request the ad landing I published?*
 *
 * Three conditions, and each excludes a way the bare parameter would misfire:
 *  - the marker is present;
 *  - the store HAS a custom domain — on any other store the platform URL never redirects and the
 *    feed link carries no parameter, so a hand-typed `?ad=1` must change nothing;
 *  - the request is on a PLATFORM host — the same string arriving on the seller's own domain would
 *    otherwise make that page `noindex` and point its canonical at another domain, which is the
 *    opposite of what the marker is for.
 */
export function isPlatformAdLanding(
  store: Pick<Store, 'customDomain'>,
  url: URL,
  requestHost: string | null,
): boolean {
  return isAdLanding(url) && hasActiveCustomDomain(store) && isPlatformHost(requestHost ?? '');
}

/**
 * The URL the platform's Google/Meta feed publishes for a store home (no `productSlug`) or a
 * product — **always on the platform domain**, per AD_LANDING_PARAM.
 *
 * The marker is appended ONLY for a store that has an active custom domain, because that is the only
 * store whose platform URL would otherwise redirect. Every other store's ad link is byte-identical
 * to its canonical, which is the property that keeps the common case free of a tracking parameter
 * Google would have to be told to ignore.
 */
export function adLandingUrl(store: Pick<Store, 'slug' | 'customDomain'>, productSlug?: string): string {
  const path = productSlug ? `/${urlSegment(store.slug)}/${urlSegment(productSlug)}` : `/${urlSegment(store.slug)}`;
  const url = `${platform.url}${path}`;
  return hasActiveCustomDomain(store) ? `${url}?${AD_LANDING_PARAM}=1` : url;
}

/** When a store has an active custom domain and the current request is NOT already on it, returns the
 *  absolute custom-domain URL to 301-redirect to — so every hit on the platform path
 *  (dezabin.co.il/<slug>, incl. the store's old default URL) permanently moves to the seller's domain
 *  and Google consolidates all accumulated ranking there (chosen 2026-07-26). Returns null when
 *  there's no active domain OR the request is already being served on it (guards the redirect loop
 *  for custom-domain traffic, which the middleware rewrites onto this same route). `pathOnCustom` is
 *  the root-relative remainder on the custom domain (search string for the home, '/<product>' + search
 *  for a product). */
export function customDomainRedirectUrl(
  store: Pick<Store, 'slug' | 'customDomain'>,
  requestHost: string | null,
  pathOnCustom: string,
): string | null {
  const cd = store.customDomain;
  if (cd?.status !== 'active') return null;
  const reqHost = (requestHost ?? '').toLowerCase().replace(/:\d+$/, '');
  if (reqHost === cd.hostname) return null;
  // Encoded HERE and not at the two call sites: `pathOnCustom` is built from `Astro.params`, which
  // is decoded, so on this Hebrew-slug catalogue the raw value cannot go into a Location header at
  // all — it throws (url-base.ts#machineUrl). One place, so a third caller inherits the answer.
  return machineUrl(`https://${cd.hostname}${pathOnCustom}`);
}

/**
 * Where a request on a hostname the store USED to be served from should go (migration 0015).
 *
 * The store sat at the ROOT of that old domain, and `storeCanonicalUrl` returns the store's base
 * wherever it lives now — its new custom domain's root, or `…/<slug>` on the platform. So the path
 * carries over untouched and lands correctly in both cases: `/blue-widget` becomes
 * `https://new-domain/blue-widget` or `https://dezabin.co.il/acme/blue-widget`.
 *
 * `machineUrl` for the same reason every other redirect in this file uses it: a product slug is
 * Hebrew here, and a raw one in a `Location` header throws a 500 instead of redirecting.
 */
export function previousDomainRedirectUrl(
  store: Pick<Store, 'slug' | 'customDomain'>,
  pathname: string,
  search = '',
): string {
  const rest = pathname === '/' ? '' : pathname;
  return machineUrl(`${storeCanonicalUrl(store)}${rest}${search}`);
}

/** The href a platform surface (store card, cart/wishlist group, discovery shelf) should use to link
 *  to a store's home. When the seller has a verified custom domain, the link leaves the platform and
 *  goes to THEIR domain — the store reads as fully sovereign, and the SEO/traffic lands on the
 *  seller's own site. Otherwise a relative in-platform path. Absolute (https://…) ⇒ external link. */
export function storeHomeHref(store: Pick<Store, 'slug' | 'customDomain'>): string {
  return hasActiveCustomDomain(store) ? `https://${store.customDomain!.hostname}` : `/${store.slug}`;
}

/** The platform's OWN hostnames — served normally. The configured platform host (± www), loopback
 *  hosts for dev, plus any extra from the PLATFORM_HOSTS env (comma-separated: staging, the direct
 *  origin behind Cloudflare, health-check hostnames, …). Everything else is either a claimed custom
 *  domain (served as a store) or an unclaimed one (404 — see isUnclaimedCustomHost). */
/** Lowercase a Host header and drop a trailing :port — WITHOUT mangling a bare IPv6 literal like
 *  `::1` (whose own colons must survive). Unwraps a bracketed `[ipv6]` / `[ipv6]:port` too. */
function normalizeRequestHost(hostname: string): string {
  const h = hostname.toLowerCase().trim();
  return h
    .replace(/^\[(.+)\](?::\d+)?$/, '$1')  // [ipv6] or [ipv6]:port → ipv6
    .replace(/^([^:]+):\d+$/, '$1');       // host:port (ipv4 / hostname, single colon) → host
}

export function isPlatformHost(hostname: string): boolean {
  const h = normalizeRequestHost(hostname);
  if (!h) return true; // no Host header → never treat as a foreign domain
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
  const platformHost = new URL(platform.url).hostname.replace(/^www\./, '');
  if (h === platformHost || h === `www.${platformHost}`) return true;
  const extra = (serverEnv('PLATFORM_HOSTS') ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return extra.includes(h);
}

/** True when a request's Host is a real external domain pointed at us but NOT claimed by any active
 *  store — an unclaimed/misconfigured custom domain. The middleware answers these with a 404 instead
 *  of silently serving the platform homepage on a stranger's domain. Deliberately conservative: an
 *  IP address, a loopback/`*.localhost` host, a single-label internal host, or any platform host is
 *  NOT treated as unclaimed (so health checks / direct-origin hits are never 404'd). */
export function isUnclaimedCustomHost(hostname: string, hasMatchingStore: boolean): boolean {
  if (hasMatchingStore) return false;
  const h = normalizeRequestHost(hostname);
  if (!h || isPlatformHost(h)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;   // IPv4 (health check / direct origin)
  if (!h.includes('.') || h.endsWith('.localhost')) return false; // internal / dev host
  return true;
}

// ── Provider selection (env-driven, lazy — mirrors email/index.ts) ──
let cached: CustomHostnameProvider | null = null;

export function getCustomDomainProvider(): CustomHostnameProvider {
  if (cached) return cached;
  const token = serverEnv('CLOUDFLARE_API_TOKEN');
  const zoneId = serverEnv('CLOUDFLARE_ZONE_ID');
  cached = token && zoneId ? createCloudflareProvider(token, zoneId) : createStubProvider();
  return cached;
}

/** Dev/CI stub — no external account. register() just echoes the CNAME instruction; checkStatus()
 *  reports 'unknown' (with no live DNS and no account there is nothing it could truthfully verify),
 *  UNLESS CUSTOM_DOMAIN_DEV_AUTOVERIFY is set, which flips it to 'active' so the full flow (incl.
 *  middleware serving) can be exercised locally. 'unknown' is also what keeps the re-check job inert
 *  wherever no provider is configured: with nothing able to confirm a domain, nothing may un-confirm
 *  one either. Never touches the network; never throws. */
export function createStubProvider(): CustomHostnameProvider {
  const autoVerify = serverEnv('CUSTOM_DOMAIN_DEV_AUTOVERIFY') === '1';
  return {
    name: 'stub',
    async register() {
      return { ok: true, verification: { cnameTarget: cnameTarget() } };
    },
    async checkStatus(): Promise<{ status: CustomDomainCheck }> {
      return { status: autoVerify ? 'active' : 'unknown' };
    },
    async remove() { /* no-op */ },
  };
}
