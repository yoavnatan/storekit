import { defineMiddleware } from 'astro:middleware';
import { logError, resolveErrorContext } from './lib/error-log.js';
import { recordPageView } from './lib/store-pageviews.js';

// Store performance's visitor count (seller dashboard) taps every real GET to
// a store's own pages here rather than each page component calling it
// separately — one place to keep in sync as store routes are added/renamed.
const STORE_PATH_RE = /^\/store\/([^/]+)(?:\/|$)/;

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
      if (storeMatch) recordPageView(storeMatch[1]);
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
