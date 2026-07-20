import { defineMiddleware } from 'astro:middleware';
import type { AstroCookies } from 'astro';
import { randomUUID } from 'node:crypto';
import { logError, resolveErrorContext } from './lib/error-log.js';
import { recordPageView } from './lib/store-pageviews.js';
import { recordProductView } from './lib/product-pageviews.js';
import { getStoreBySlug } from './lib/stores.js';
import { getProductBySlug } from './lib/store-products.js';

// Store performance's visitor count (seller dashboard) taps every real GET to
// a store's own pages here rather than each page component calling it
// separately — one place to keep in sync as store routes are added/renamed.
const STORE_PATH_RE = /^\/store\/([^/]+)(?:\/|$)/;
// A product page is exactly `/store/<storeSlug>/<productSlug>` (trailing slash
// tolerated). The per-product drill-down (seller performance tab) taps its views
// here for the same single-source-of-truth reason as the store counter above.
const PRODUCT_PATH_RE = /^\/store\/([^/]+)\/([^/]+)\/?$/;

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
  try {
    if (context.request.method === 'GET') {
      const pathname = new URL(context.request.url).pathname;
      const storeMatch = pathname.match(STORE_PATH_RE);
      if (storeMatch) recordPageView(storeMatch[1], resolveVisitorId(context.cookies));
      // A product page also counts one product-level view. Resolve slug→id so
      // history keys on the immutable product id (a rename changes the slug).
      // Wrapped so a lookup miss/failure never affects the response — analytics.
      const productMatch = pathname.match(PRODUCT_PATH_RE);
      if (productMatch) {
        try {
          const st = getStoreBySlug(productMatch[1]!);
          const prod = st ? getProductBySlug(st.id, productMatch[2]!) : null;
          if (prod) recordProductView(prod.id);
        } catch { /* analytics tap must never break the request */ }
      }
    }
    return await next();
  } catch (err) {
    const pathname = new URL(context.request.url).pathname;
    logError({
      source: 'server',
      route: pathname,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      statusCode: 500,
      ...resolveErrorContext(pathname, context.cookies),
    });
    throw err;
  }
});
