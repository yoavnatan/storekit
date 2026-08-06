/**
 * `outboundFetch`'s deadline, proved against a server that really does hang.
 *
 * `outbound-fetch-guard.test.ts` is the other half and checks a different thing: that no call site
 * bypasses the wrapper. It says nothing about whether the wrapper works. This file drives the exact
 * outage the wrapper exists for — a third party that has NOT crashed but has stopped answering,
 * which is the common shape of a provider incident and the one Node handles worst: undici waits 300
 * seconds for headers and another 300 for a body. Every call site is `await`ed inside an SSR route
 * or inside `notifyOrderStatusChanged`, so without a deadline a hung Resend or a hung Cloudflare is
 * a hung page for the buyer or the seller, and no `try/catch` at the call site helps because the
 * call never returns to be caught.
 *
 * Real sockets, not a mocked `fetch`. A mock would assert that the code passes a signal; only a
 * server that accepts the connection and then says nothing proves the signal is honoured — which is
 * the claim, and the reason the bug is invisible in review.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { outboundFetch } from '../src/lib/outbound-fetch.js';

/** Sockets deliberately left hanging, so they can be destroyed when the suite ends — otherwise the
 *  server's `close` waits on them and the run does not exit. */
const hanging: { destroy(): void }[] = [];
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/never-answers') {
      // Connection accepted, request read, and then nothing. No headers, no body, no close. This is
      // an overloaded provider holding the socket open, not a crashed one.
      hanging.push(res.socket!);
      return;
    }
    if (req.url === '/trickles') {
      // Headers arrive at once and the body never finishes — the case a socket-inactivity timeout
      // would also miss, and the reason `AbortSignal.timeout` bounds the whole request.
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '1000' });
      res.write('x');
      hanging.push(res.socket!);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('quick');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const socket of hanging) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a third party that stops answering', () => {
  it('gives up at the deadline instead of holding the request for undici\'s 300 seconds', async () => {
    const started = Date.now();
    await expect(outboundFetch(`${origin}/never-answers`, { timeoutMs: 300 })).rejects.toThrow();
    // Generously bounded — the assertion is "it returned in the same breath", not a stopwatch
    // reading. Without the deadline this line is reached five minutes later, or never.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('names the timeout, so a caller can say "the provider did not answer" rather than "refused"', async () => {
    // The two are different incidents and lead to different next steps. A connection refused is
    // "they are down"; a deadline passed is "they are up and stuck", which is the one that also
    // means an idempotent retry may well succeed.
    await outboundFetch(`${origin}/never-answers`, { timeoutMs: 300 }).then(
      () => expect.unreachable('a hung server must not resolve'),
      (err: unknown) => expect((err as Error).name).toBe('TimeoutError'),
    );
  });

  it('bounds a response whose BODY never finishes, not just its headers', async () => {
    // Headers arrive immediately here, so anything measuring only time-to-first-byte reports this
    // request as healthy while it holds a socket and a request slot indefinitely.
    const started = Date.now();
    await expect(
      outboundFetch(`${origin}/trickles`, { timeoutMs: 300 }).then((res) => res.text()),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('a third party that answers', () => {
  it('is not affected by the deadline', async () => {
    const res = await outboundFetch(`${origin}/fine`, { timeoutMs: 2_000 });
    expect(await res.text()).toBe('quick');
  });

  it('honours a caller\'s own signal as well as the deadline — whichever fires first', async () => {
    // `AbortSignal.any` composes them. Getting this wrong by REPLACING the caller's signal would
    // pass every happy-path test and silently ignore a cancellation the caller depends on.
    const caller = new AbortController();
    const pending = outboundFetch(`${origin}/never-answers`, { timeoutMs: 60_000, signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe('the browser call sites', () => {
  // The guard test cannot reach these: a browser third-party fetch is `fetch(url)` where `url` came
  // out of an input's value, which is textually identical to the same-origin `fetch(url)` calls the
  // rule allows on purpose. A static check precise enough to tell them apart does not exist, so the
  // two that matter are named. Both re-fetch a stored image from Cloudinary behind a loading state,
  // and a hung CDN used to leave the seller's button spinning with no error and no way out.
  it.each([
    'src/scripts/dashboard/store-image.ts',
    'src/scripts/dashboard/gallery.ts',
  ])('%s re-fetches a stored image through outboundFetch, not a bare fetch', async (file) => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(source, `${file} must import outboundFetch`).toMatch(/import \{ outboundFetch \}/);
    // No bare `fetch(` left holding a URL that is not ours. `cdnSrc(`/`/api/` spellings would be
    // fine; today there are none of either in these two files, so the assertion is simply zero.
    const bare = [...source.matchAll(/(^|[^.\w$])fetch\s*\(/gm)];
    expect(bare.map((m) => m[0]), `${file} has a bare fetch(`).toEqual([]);
  });
});

describe('the default', () => {
  it('is ten seconds — a number about the caller, not about the network', async () => {
    // Every current call site sits on a request a human is waiting on: an OAuth callback mid-login,
    // a custom-domain save in the dashboard, an order email inside a status change. Ten seconds is
    // already past the point where that person believes the page is broken, so a longer default only
    // chooses a slower failure over a faster one. Asserted against the source because the constant
    // is deliberately not exported — changing it should be a decision, and this is where it argues.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/lib/outbound-fetch.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/const DEFAULT_TIMEOUT_MS = 10_000;/);
  });
});
