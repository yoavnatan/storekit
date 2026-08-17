import { defineMiddleware } from 'astro:middleware';
import { resolveVisitorId } from './lib/visitor.js';
import { gzipResponse } from './lib/http-compress.js';
import { reportStreamErrors } from './lib/stream-errors.js';
import { logError } from './lib/error-log.js';
import { contentSecurityPolicy } from './lib/csp.js';
import { recordPageViewTap } from './lib/page-view-tap.js';
import { isBotRequest } from './lib/bot-detect.js';
import { getSellerSession } from './lib/seller-auth.js';
import { getStoreBySlug, getStoreByCustomDomain, isReservedSlug } from './lib/stores.js';
import { resolveCustomDomainRewrite, isUnclaimedCustomHost, isPlatformHost } from './lib/custom-domain.js';
import { unclaimedHostRedirect } from './lib/unclaimed-host.js';
import { getProductBySlug } from './lib/store-products.js';
import { ensureSchedulerStarted } from './lib/jobs/scheduler.js';
import { HEALTH_PATH } from './pages/api/health.js';
import { csrfRejection, csrfRequired, csrfTokenFromRequest, verifyCsrfToken } from './lib/csrf.js';
import { ensureShutdownHookInstalled, trackRequest } from './lib/shutdown.js';
import { ensureProcessErrorHandlersInstalled } from './lib/process-errors.js';
import { captureAttribution } from './lib/attribution.js';
import { adoptHandoff, platformPageUrl } from './lib/cross-origin-handoff.js';
import { isPlatformOwnedPath } from './lib/platform-routes.js';

// Stores live at the platform ROOT now — a store home is `/<slug>` and a product page is
// `/<slug>/<product>` (no `/store/` prefix). So we can't tell a store path from a real platform
// route (/checkout, /search, …) by shape alone: the first segment is resolved against the store
// registry (getStoreBySlug), and reserved routes are skipped up front. This single tap keeps the
// seller dashboard's visitor + per-product view counts in one place.
const STORE_PATH_RE = /^\/([^/]+)(?:\/([^/]+))?\/?$/;

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
  // Third ignition at the same point and for the same reason (lib/process-errors.ts): the net under
  // every fire-and-forget promise in the process, which by definition has no request to report on.
  ensureProcessErrorHandlersInstalled();
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

    // `/api/health` skips the rest, and the reason is the outage it exists to report. Everything
    // below this line touches the database — the custom-domain lookup first, then the analytics
    // tap — so with Postgres unreachable the middleware throws and the route never executes. The
    // endpoint whose entire job is to answer "503, the database is down" would instead be a 500
    // HTML error page, i.e. broken in exactly and only the situation it was built for. (Found by
    // pointing DATABASE_URL at a dead host, 2026-08-05; invisible anywhere the database works.)
    //
    // **BELOW the CSRF gate, not above it.** The first version of this line was above, which was
    // wrong on principle even though it was harmless in fact: the route exports only GET, so no
    // token is ever required for it and nothing changed either way. But "the ONE place this
    // application checks a token" stops being true the moment any path is allowed around it, and
    // the next person to add a POST handler here would inherit an exemption nobody chose. The gate
    // costs a set lookup and an HMAC — no database — so keeping it in front costs this endpoint
    // nothing that matters when the database is down.
    //
    // Nothing else is skipped either: the two ignition calls and `trackRequest()` ran above, so the
    // probe is still counted by the graceful-shutdown drain. Nothing below is needed — it takes no
    // cookies, resolves no store, and is not a page view. `HEALTH_PATH` lives in the route file so
    // the path is declared once, by the thing that owns it.
    if (pathname === HEALTH_PATH) return next();

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
      // **The platform's own host skips all of it, and that is not just an optimisation.** A seller
      // can never claim the platform hostname (`normalizeHostname` refuses it), so for the host that
      // serves virtually every request this block was guaranteed to look up nothing and find
      // nothing — one indexed SELECT in front of every page load, before a single thing the page
      // actually needs. No-op in effect, a round trip in cost.
      if (host && !isPlatformHost(host)) {
        const cdStore = await getStoreByCustomDomain(host);
        if (cdStore) {
          // **The transaction belongs to the platform** (`platform-routes.ts` carries the decision
          // and the reasoning). Checkout, the cart, login and the buyer area are the platform's to
          // serve, and on this host they would run in a DIFFERENT ORIGIN: a separate cookie jar and
          // a separate `localStorage`, so the shopper would arrive logged out with an empty cart and
          // no ad attribution. The page rewrites these links before a click happens
          // (`custom-domain-links.ts`), so a shopper normally never reaches this line — it is the
          // floor under a middle-click, a bookmark, a typed URL and a page whose script did not run.
          // 302, not 301: the URL is the seller's and this answer is about where the SESSION lives,
          // not a permanent move, and a cached 301 would outlive the store's domain.
          if (isPlatformOwnedPath(pathname)) {
            return context.redirect(platformPageUrl(pathname, reqUrl.search), 302);
          }
          const target = resolveCustomDomainRewrite(cdStore.slug, pathname);
          if (target) return context.rewrite(target + reqUrl.search);
        } else if (isUnclaimedCustomHost(host, false)) {
          // Nobody claims this host TODAY — but it may be a hostname a store moved off, or the
          // www/apex twin of one it still uses. Both are the seller's own address in a visitor's
          // hands, and both used to answer 404. See `unclaimedHostRedirect`.
          const moved = await unclaimedHostRedirect(host, pathname, reqUrl.search);
          if (moved) return context.redirect(moved, 301);
          // A real external domain is pointed at us but no store claims it and none ever did (DNS
          // set up before the store connected, or a stranger's misconfiguration). Answer 404 rather
          // than serve the platform homepage on a stranger's domain.
          return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
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
    // **Arriving FROM a seller's own domain (lib/cross-origin-handoff.ts).** A custom domain is a
    // different browser origin, so `sn_vid` and `sn_attr` — both host-scoped by design — do not
    // cross it, and the shopper would land here as a brand-new visitor with no ad click. The
    // crossing carries a signed token instead, and it is consumed HERE, before the two lines below
    // read those cookies: seeding after `resolveVisitorId` had already minted a fresh id would
    // leave the store's conversion rate counting one shopper twice.
    //
    // The parameter is left in the URL for the page to strip client-side. A redirect would have been
    // the obvious way to clean it and is the wrong tool here: the handed-over cart rides in the URL
    // FRAGMENT, and spending a round trip on cosmetics is charged to the one navigation that has to
    // feel instant. Nothing indexes it either way — the canonical is query-stripped and /checkout is
    // `noindex`.
    if (isPageCandidate) adoptHandoff(reqUrl, context.cookies);

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
    //
    // `reportStreamErrors` goes INSIDE the gzip so it reads Astro's own stream: it is the half of
    // the error surface this `try/catch` cannot reach. `await next()` resolved the moment the
    // page's frontmatter finished, so everything the template renders after that — including every
    // component's frontmatter, `BaseLayout` included — throws outside the block below and was
    // reaching the socket as a bare "Internal server error" with nothing written to the log.
    // The security policy, on the document and only on the document. It governs what a PAGE may
    // load, so putting it on an API JSON response or an asset says nothing and only makes the
    // header harder to read in a browser's network tab. Set here rather than per route for the
    // reason every rule in this file is here: one place, so a new page cannot be born without it.
    if ((response.headers.get('content-type') ?? '').includes('text/html')) {
      response.headers.set('Content-Security-Policy', contentSecurityPolicy());
    }

    return gzipResponse(
      context.request,
      reportStreamErrors(response, (err) => {
        void logError({
          source: 'server',
          route: pathname,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          // Not 500: the status line went out before this failed, and it was whatever the route
          // decided. Recording a 500 here would be inventing a status the visitor never received.
          statusCode: response.status,
          resolutionHint: 'Thrown while streaming the response — after the headers were sent, so no error page could be shown. Look at a component rendered by this route, not at its frontmatter.',
        }, { pathname, cookies: context.cookies });
      }),
    );
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
