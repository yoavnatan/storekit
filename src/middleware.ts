import { defineMiddleware } from 'astro:middleware';
import { logError } from './lib/error-log.js';

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
    return await next();
  } catch (err) {
    logError({
      source: 'server',
      route: new URL(context.request.url).pathname,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      statusCode: 500,
    });
    throw err;
  }
});
