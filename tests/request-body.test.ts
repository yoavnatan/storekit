/**
 * The body cap that is measured rather than declared — plus the grep guard that keeps the next
 * route from re-inventing the version that isn't.
 *
 * Found by the review pass on the analytics diff (2026-08-02). Both unauthenticated POST endpoints
 * capped their body by reading `Content-Length` and then calling `request.json()`. A request that
 * omits the header — every chunked request does — read as `0`, passed the check, and was buffered
 * and parsed in full. The cap stopped an oversized body only when the sender was honest about its
 * size, which is the failure mode of a limit that makes an endpoint look bounded.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonBody } from '../src/lib/request-body.js';

/** A body delivered as a stream with NO content-length header — the shape that used to slip past. */
function chunkedRequest(payload: string, chunkSize = 64): Request {
  const bytes = new TextEncoder().encode(payload);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  // `duplex` is required by undici whenever the body is a stream.
  return new Request('https://example.test/api', {
    method: 'POST',
    body: stream,
    // @ts-expect-error — Node's fetch needs this and the DOM lib does not declare it.
    duplex: 'half',
  });
}

describe('readJsonBody', () => {
  it('parses a body within the cap', async () => {
    const read = await readJsonBody(new Request('https://example.test/api', {
      method: 'POST', body: JSON.stringify({ type: 'add_to_cart' }),
    }), 2_000);
    expect(read).toEqual({ ok: true, value: { type: 'add_to_cart' } });
  });

  it('rejects an oversized body that declares no length at all', async () => {
    // THE regression. With the old check this returned `ok` after buffering every byte.
    const huge = JSON.stringify({ type: 'add_to_cart', pad: 'x'.repeat(50_000) });
    const request = chunkedRequest(huge);
    expect(request.headers.get('content-length')).toBeNull();
    expect(await readJsonBody(request, 2_000)).toEqual({ ok: false, status: 413 });
  });

  it('rejects an oversized body that declares an honest length, without reading it', async () => {
    const read = await readJsonBody(new Request('https://example.test/api', {
      method: 'POST', body: 'x'.repeat(5_000),
    }), 2_000);
    expect(read).toEqual({ ok: false, status: 413 });
  });

  it('counts bytes, not characters', async () => {
    // 800 Hebrew characters are 1,600 bytes in UTF-8. A cap applied to `.length` would pass this.
    const payload = JSON.stringify({ note: 'א'.repeat(800) });
    expect(await readJsonBody(chunkedRequest(payload), 1_000)).toEqual({ ok: false, status: 413 });
  });

  it('accepts a streamed body that stays under the cap', async () => {
    const payload = JSON.stringify({ type: 'add_to_cart', productId: 'p-1' });
    expect(await readJsonBody(chunkedRequest(payload, 4), 2_000)).toEqual({
      ok: true, value: { type: 'add_to_cart', productId: 'p-1' },
    });
  });

  it('answers 400 — not a throw — for a body that is absent or not JSON', async () => {
    expect(await readJsonBody(new Request('https://example.test/api', { method: 'POST' }), 2_000))
      .toEqual({ ok: false, status: 400 });
    expect(await readJsonBody(chunkedRequest('{"unclosed": '), 2_000)).toEqual({ ok: false, status: 400 });
  });
});

describe('GUARD: no route caps a body by trusting a header', () => {
  it('nothing outside request-body.ts reads content-length to gate a body read', () => {
    // Same shape as tests/safe-redirect.test.ts: the rule is only a rule while a second copy of it
    // cannot appear. A route that re-derives this cap re-derives the hole with it.
    const root = path.join(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|astro)$/.test(entry.name)) continue;
        const rel = path.relative(process.cwd(), full);
        if (rel.endsWith(path.join('lib', 'request-body.ts'))) continue;
        // http-compress.ts DELETES the header on a response it rewrote — not a read of an
        // incoming claim, and the one legitimate mention.
        if (rel.endsWith(path.join('lib', 'http-compress.ts'))) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/headers\s*\.\s*get\(\s*['"]content-length['"]/i.test(src)) offenders.push(rel);
      }
    };
    walk(root);
    expect(offenders, 'read the body through lib/request-body.ts#readJsonBody instead').toEqual([]);
  });

  it('every request.json() in an API route goes through the helper', () => {
    const apiRoot = path.join(process.cwd(), 'src', 'pages', 'api');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/request\s*\.\s*json\s*\(/.test(src)) offenders.push(path.relative(process.cwd(), full));
      }
    };
    walk(apiRoot);
    // An unbounded `await request.json()` lets the sender choose how much memory the parse takes.
    // Authenticated routes are a smaller target, not a safe one — a session is cheap to obtain.
    expect(offenders, 'use lib/request-body.ts#readJsonBody, which caps the bytes it reads').toEqual([]);
  });
});
