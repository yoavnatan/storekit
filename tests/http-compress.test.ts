import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { gzipResponse, shouldCompress } from '../src/lib/http-compress.js';

/** Every SSR response passes through this, so the interesting cases are the ones where it must
 *  keep its hands off: a client that can't decode gzip, a body that is already compressed bytes,
 *  and a response that has no body at all. Getting any of those wrong doesn't slow the site down
 *  — it breaks it. */

const req = (accept?: string): Request =>
  new Request('https://dezabin.co.il/', accept ? { headers: { 'accept-encoding': accept } } : undefined);

const res = (body: string | null, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}): Response =>
  new Response(body, { headers: { 'content-type': type, ...extra } });

const HTML = `<!doctype html><html><body>${'<p>מדף חנויות</p>'.repeat(200)}</body></html>`;

describe('gzipResponse', () => {
  it('compresses HTML for a client that asked, and the bytes still decode to the original', async () => {
    const out = gzipResponse(req('gzip, deflate, br'), res(HTML));
    expect(out.headers.get('content-encoding')).toBe('gzip');
    const raw = Buffer.from(await out.arrayBuffer());
    expect(raw.length).toBeLessThan(Buffer.byteLength(HTML) / 4);
    expect(gunzipSync(raw).toString('utf8')).toBe(HTML);
  });

  it('drops content-length and marks Vary, so no cache can serve gzip to a client that cannot read it', () => {
    const out = gzipResponse(req('gzip'), res(HTML, 'text/html', { 'content-length': '999', vary: 'Cookie' }));
    expect(out.headers.get('content-length')).toBeNull();
    expect(out.headers.get('vary')).toBe('Cookie, Accept-Encoding');
  });

  it('leaves the response alone when the client did not ask for gzip', async () => {
    const out = gzipResponse(req(), res(HTML));
    expect(out.headers.get('content-encoding')).toBeNull();
    expect(await out.text()).toBe(HTML);
  });

  it('never double-encodes a body that already is compressed', () => {
    const already = res(HTML, 'text/html', { 'content-encoding': 'br' });
    expect(gzipResponse(req('gzip'), already)).toBe(already);
  });

  it('skips formats that are already compressed bytes — gzip would only add to them', () => {
    for (const type of ['image/webp', 'image/jpeg', 'font/woff2', 'video/mp4', 'application/zip']) {
      expect(shouldCompress(req('gzip'), res('binary', type))).toBe(false);
    }
  });

  it('covers the text types this app actually serves', () => {
    for (const type of ['text/html; charset=utf-8', 'application/json', 'text/css', 'application/xml',
      'application/rss+xml', 'text/plain', 'application/ld+json']) {
      expect(shouldCompress(req('gzip'), res('x', type)), type).toBe(true);
    }
  });

  it('leaves a bodyless response (304 / redirect) untouched', () => {
    const redirect = new Response(null, { status: 302, headers: { location: '/', 'content-type': 'text/html' } });
    expect(gzipResponse(req('gzip'), redirect)).toBe(redirect);
  });
});
