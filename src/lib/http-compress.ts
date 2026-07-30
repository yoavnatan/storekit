/**
 * Gzip an SSR response on its way out.
 *
 * Measured on the built homepage (2026-07-30, `astro build` + the node adapter on a spare port):
 * 274KB of HTML on the wire, 42KB gzipped — ~85% of the bytes on the critical path were being
 * sent for nothing. It surfaced as "the images take forever to load": they don't (every one goes
 * through Cloudinary, ~330KB for the whole page, `max-age=604800`, and a refresh serves them all
 * from cache with zero bytes) — but no `<img>` can be DISCOVERED before the HTML carrying it has
 * arrived, and on a 1.6Mbps link that HTML alone took 3.5s. With this it takes 0.6s.
 *
 * `@astrojs/node` has no compression of its own, and middleware is the only layer that sees an
 * SSR response before it leaves the process. Lives here rather than inline in `middleware.ts` so
 * the rule is testable on its own — see `tests/http-compress.test.ts`.
 *
 * NOT covered, and it cannot be: everything the adapter serves straight out of `dist/client`
 * (`BaseLayout.css` at 201KB, the JS bundles, the fonts). Those never reach middleware and need
 * gzip/brotli at the proxy or CDN in front of the app — a deploy step, logged in
 * GO_LIVE_CHECKLIST §1.
 */
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

/** Worth compressing. Images, fonts, video and zip archives are already compressed formats —
 *  gzipping them burns CPU to add bytes. */
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|rss\+xml|xhtml\+xml|ld\+json))/i;

/** Whether this exact response should be gzipped. Split out so the decision can be asserted
 *  without building a stream. */
export function shouldCompress(request: Request, response: Response): boolean {
  if (!response.body) return false;                                    // 304 / redirect / HEAD
  if (response.headers.has('content-encoding')) return false;          // already encoded
  if (!/\bgzip\b/i.test(request.headers.get('accept-encoding') ?? '')) return false;
  return COMPRESSIBLE.test(response.headers.get('content-type') ?? '');
}

/** The compressed response, or the original untouched when it isn't a candidate. Streams
 *  (`fromWeb → gzip → toWeb`) rather than buffering with `await response.text()`, so Astro's
 *  streamed HTML keeps streaming and a large page never has to sit in memory before its first
 *  byte goes out. */
export function gzipResponse(request: Request, response: Response): Response {
  if (!shouldCompress(request, response)) return response;

  const headers = new Headers(response.headers);
  headers.set('content-encoding', 'gzip');
  // The compressed length is unknown up front — the adapter falls back to chunked transfer.
  headers.delete('content-length');
  // Anything caching this must key on the encoding, or a shared cache can hand a gzipped body to
  // a client that never asked for one.
  const vary = headers.get('vary');
  if (!vary) headers.set('vary', 'Accept-Encoding');
  else if (!/accept-encoding/i.test(vary)) headers.set('vary', `${vary}, Accept-Encoding`);

  const gz = Readable.fromWeb(response.body as unknown as NodeWebReadableStream).pipe(createGzip());
  return new Response(Readable.toWeb(gz) as unknown as ReadableStream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
