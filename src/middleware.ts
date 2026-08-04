import { defineMiddleware } from 'astro:middleware';
import type { AstroCookies } from 'astro';
import { randomUUID } from 'node:crypto';
import { gzipResponse } from './lib/http-compress.js';
import { logError } from './lib/error-log.js';
import { recordPageViewTap } from './lib/page-view-tap.js';
import { isBotRequest } from './lib/bot-detect.js';
import { getSellerSession } from './lib/seller-auth.js';
import { getStoreBySlug, getStoreByCustomDomain, isReservedSlug } from './lib/stores.js';
import { resolveCustomDomainRewrite, isUnclaimedCustomHost } from './lib/custom-domain.js';
import { getProductBySlug } from './lib/store-products.js';
import { ensureSchedulerStarted } from './lib/jobs/scheduler.js';
import { csrfRejection, csrfRequired, csrfTokenFromRequest, verifyCsrfToken } from './lib/csrf.js';
import { ensureShutdownHookInstalled, trackRequest } from './lib/shutdown.js';
import { captureAttribution } from './lib/attribution.js';

// Stores live at the platform ROOT now — a store home is `/<slug>` and a product page is
// `/<slug>/<product>` (no `/store/` prefix). So we can't tell a store path from a real platform
// route (/checkout, /search, …) by shape alone: the first segment is resolved against the store
// registry (getStoreBySlug), and reserved routes are skipped up front. This single tap keeps the
// seller dashboard's visitor + per-product view counts in one place.
const STORE_PATH_RE = /^\/([^/]+)(?:\/([^/]+))?\/?$/;

// Stable first-party visitor id — analytics only, httpOnly so it never reaches
// client JS or a third party. Lets store performance tell unique visitors apart
// from raw visit count (repeat loads by the same browser reuse this id). Set
// lazily on the first store-page GET; a ~13-month TTL means a returning visitor
// still de-dupes across a long gap.
const VISITOR_COOKIE = 'sn_vid';
function resolveVisitorId(cookies: AstroCookies): string {
  const existing = cookies.get(VISITOR_COOKIE)?.value;
  if (existing) return existing;
  const id = randomUUID().replace(/-/g, '').slice(0, 20);
  cookies.set(VISITOR_COOKIE, id, { path: '/', maxAge: 60 * 60 * 24 * 400, httpOnly: true, sameSite: 'lax' });
  return id;
}

// Pure observability tap — logs unexpected server errors so the admin
// Alerts tab has something to show, but never changes what the caller
// actually gets back. A route that throws still throws; a route that
// already returns its own error Response still returns exactly that.
//
// Only logs on a genuinely thrown/uncaught exception, not on any route that
// deliberately returns a >=500 status itself (e.g. auth/google.ts's 503 for
// "OAuth not configured" is an expected, non-error response) — a route that
// wants its own caught error visible in the Alerts tab should call
// logError() directly, the same way checkout.ts does, so the log entry
// carries a real message/stack instead of a content-free "unhandled 500".
export const onRequest = defineMiddleware(async (context, next) => {
  // The background scheduler's ignition (lib/jobs/scheduler.ts, DB_MIGRATION_PLAN.md §8 stage 4a).
  // Astro's node adapter exposes no "server started" hook, so the first request this process
  // handles is the earliest point that is guaranteed to run exactly once in a process that is
  // actually serving. After that first call it is a single comparison and returns; it starts no
  // work here and awaits nothing, so it cannot add latency to the request it rides in on.
  ensureSchedulerStarted();
  // Same ignition point, same reason (lib/shutdown.ts): the adapter owns the HTTP server and hands
  // `src/` no "server started" hook, so the first served request is where our signal handlers get
  // installed. `release()` sits in the outermost `finally` below — a request that leaks its slot
  // makes every future deploy wait out the full drain deadline.
  ensureShutdownHookInstalled();
  const releaseRequest = trackRequest();
  try {
    const isGet = context.request.method === 'GET';
    const reqUrl = new URL(context.request.url);
    const pathname = reqUrl.pathname;

    // The CSRF gate — the ONE place this application checks a token, for every on-demand route it
    // has (lib/csrf.ts carries the reasoning, including what the other two layers already cover).
    // First, so a forged request is refused before it costs a database lookup, a rewrite, or a
    // page-view write. GET/HEAD/OPTIONS fall straight through on a set lookup.
    if (csrfRequired(context.request.method, pathname)
        && !verifyCsrfToken(await csrfTokenFromRequest(context.request), context.cookies)) {
      return csrfRejection();
    }

    // Custom-domain routing (see custom-domain.ts). A seller's own domain (shop.mybrand.co.il),
    // once verified, serves their store from the root. Cloudflare-for-SaaS proxies the request to
    // this origin preserving the original Host, so we resolve Host → store here and rewrite the
    // path to the internal /<slug> route. Only page-like requests (no file extension) are
    // even considered, so assets skip the lookup entirely; /api and deep paths pass
    // through untouched (resolver returns null), which also prevents a rewrite loop on re-entry.
    // The platform's own host never matches a customDomain (normalizeHostname forbids claiming it),
    // so this block is a no-op for all normal platform traffic.
    if (!/\.[a-z0-9]+$/i.test(pathname)) {
      const host = context.request.headers.get('host') ?? reqUrl.host;
      const cdStore = host ? await getStoreByCustomDomain(host) : null;
      if (cdStore) {
        const target = resolveCustomDomainRewrite(cdStore.slug, pathname);
        if (target) return context.rewrite(target + reqUrl.search);
      } else if (host && isUnclaimedCustomHost(host, false)) {
        // A real external domain is pointed at us but no active store claims it (removed, or DNS set
        // up before the store connected). Answer 404 rather than serve the platform homepage on a
        // stranger's domain — a random domain must never render as if it were ours.
        return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    }
    // A navigable page — the only kind we count in the first-party funnel and
    // resolve a visitor id for. Excludes API calls, static assets (any path with
    // a file extension), the admin backend (the owner's own browsing must not
    // pollute the shopper funnel), and non-human clients: robots.txt invites a
    // dozen crawlers on purpose, and counting their visits as page views tells a
    // seller the mall sent traffic that didn't buy. The definitive HTML check
    // happens after next().
    const isHuman = !isBotRequest(context.request);
    const isPageCandidate = isGet
      && isHuman
      && !pathname.startsWith('/api/')
      && !pathname.startsWith('/admin')
      && !/\.[a-z0-9]+$/i.test(pathname);
    const vid = isPageCandidate ? resolveVisitorId(context.cookies) : '';

    // First-party ad attribution (lib/attribution.ts, GO_LIVE_CHECKLIST.md §2.5 layer 5). If THIS
    // landing carries a click id or UTM tags they go into a first-party cookie, and /api/checkout
    // stamps them onto the orders. Same gate as the visitor id, for the same reason — an ad click
    // is a human arriving on a page — and a landing without parameters is a no-op that leaves an
    // earlier click's cookie intact, which is what makes a lookback window mean anything.
    if (isPageCandidate) captureAttribution(reqUrl, context.cookies);

    // Resolve the first path segment to a store (root-level routing). A one-segment path that
    // resolves to a store counts a store visit; a two-segment path additionally counts a product
    // view. Reserved routes and asset paths never reach getStoreBySlug. All wrapped so an analytics
    // lookup miss/failure can never affect the response.
    const pathMatch = isGet && isHuman ? pathname.match(STORE_PATH_RE) : null;
    let viewedStoreId = '';
    let viewedProductId = '';
    let ownerViewingOwnStore = false;
    if (pathMatch && !isReservedSlug(pathMatch[1]!) && !pathMatch[1]!.includes('.')) {
      try {
        const st = await getStoreBySlug(pathMatch[1]!);
        // A seller looking at their own storefront is not a visit. The dashboard's
        // "צפה בחנות" button sends them here constantly while they set the store
        // up — and because that page IS the live store (no preview mode), every
        // one of those was landing in the seller's own visit count, which is the
        // number they use to judge whether the mall works. Same identity check the
        // page itself uses (own-store-guard / isOwner). Their visits to OTHER
        // stores still count: there they really are a shopper.
        ownerViewingOwnStore = !!st && getSellerSession(context.cookies) === st.sellerId;
        if (st && !ownerViewingOwnStore) {
          // Keyed by store id, not slug: a store that renames its URL keeps its history without
          // anything having to migrate it. Nothing is WRITTEN here — the ids are resolved now
          // (the request is already paying for these reads) and handed to the single tap below.
          viewedStoreId = st.id;
          // A product page also counts one product-level view. Resolve slug→id so history keys on
          // the immutable product id (a rename changes the slug).
          const productSlug = pathMatch[2];
          const prod = productSlug ? await getProductBySlug(st.id, productSlug) : null;
          if (prod) viewedProductId = prod.id;
        }
      } catch { /* analytics tap must never break the request */ }
    }

    const response = await next();

    // Everything this page view counts, in ONE statement (`page-view-tap.ts`) — the funnel event,
    // the narrower stage, the store's counter and the product's. It used to be four round trips
    // from three modules, four of the five a page load spends.
    //
    // Only on a real HTML page response, so redirects and asset 200s never inflate the numbers.
    // **That gate now covers the store and product counters too, and it did not before:** they were
    // written before `next()` ran, so a visit to a hidden or moved store — a 302 to
    // /store-unavailable, never a page the visitor saw — still counted as a view of it. Fire-and-
    // forget and never throws (see the tap). page_view = a session touched the site; the narrower
    // stages map product pages → view_item, the checkout page → begin_checkout, and the seller
    // register page → the seller-funnel top.
    if (isPageCandidate && !ownerViewingOwnStore && (response.headers.get('content-type') ?? '').includes('text/html')) {
      const stage = viewedProductId ? 'view_item'
        : pathname === '/checkout' ? 'begin_checkout'
        : pathname === '/seller/register' ? 'seller_register_view'
        : null;
      void recordPageViewTap({
        events: stage ? ['page_view', stage] : ['page_view'],
        visitorId: vid,
        storeId: viewedStoreId,
        productId: viewedProductId,
        ...(viewedProductId ? { productEvent: 'view_item' as const, productIds: [viewedProductId] } : {}),
      });
    }
    // Last thing before it leaves the process, so every SSR route is covered by one rule and the
    // analytics tap above still sees the real, uncompressed response headers.
    return gzipResponse(context.request, response);
  } catch (err) {
    const pathname = new URL(context.request.url).pathname;
    // Not awaited, and the identity lookup moved INSIDE it: this runs on every 500, so when the
    // database is what broke, every request would otherwise sit here holding a pooled connection
    // until it times out — an outage amplifying itself into a frozen site. error-log.ts explains
    // the rule and caps how much of the pool it may hold.
    void logError({
      source: 'server',
      route: pathname,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      statusCode: 500,
    }, { pathname, cookies: context.cookies });
    throw err;
  } finally {
    // Outermost, so a thrown request releases its slot too — see the note at `trackRequest`.
    releaseRequest();
  }
});
