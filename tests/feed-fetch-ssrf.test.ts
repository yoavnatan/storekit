/**
 * The SSRF guard on the seller-supplied inventory feed URL, and the DNS pin that stage 4a required
 * before it could put that fetch on a timer (DB_MIGRATION_PLAN.md §8, GO_LIVE §6.1).
 *
 * **What was actually wrong, and why a timer changes it.** The module resolved the hostname, checked
 * every returned address, and then handed the HOSTNAME to the HTTP client — which resolved it again.
 * Two resolutions, and an attacker controlling the authoritative DNS for their own name is free to
 * answer a public address the first time and 127.0.0.1 the second. The address that passed the check
 * is not the address that gets dialled. That was written down as an accepted risk, and the reasoning
 * was sound while a seller pressing a button was the only way it could fire: a human, a handful of
 * times, watching the result. An unattended job retrying every hour is the exact condition the
 * attack needs — repeatable, and nobody looking.
 *
 * So the checked address is carried forward and forced onto the socket. Proving that is the hard
 * part of this file, and it is proved the only way that cannot be faked: the request is aimed at a
 * hostname under `.invalid`, a TLD reserved by RFC 2606 which no resolver on earth will answer for.
 * If it connects, the address cannot have come from a resolver. The negative half is asserted too —
 * the same request without the pin fails — because a test that only shows the good case would also
 * pass if the URL happened to resolve by accident.
 */
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertSafeUrl, fetchFeedCsv, fetchPinned, ipIsPrivate, pinnedLookup, MAX_FEED_BYTES,
} from '../src/lib/feed-fetch.js';

/** A hostname that resolves NOWHERE (RFC 2606 reserves `.invalid`). Any successful connection to it
 *  is proof the address came from the pin rather than from DNS. */
const UNRESOLVABLE = 'feed.example.invalid';

interface Route { status?: number; headers?: Record<string, string>; body?: string | Buffer }

const servers: http.Server[] = [];

/** A one-route HTTP server on loopback, plus the Host header it last saw. */
async function serve(route: Route | ((req: http.IncomingMessage, res: http.ServerResponse) => void)): Promise<{ port: number; hostSeen: () => string | undefined }> {
  let hostSeen: string | undefined;
  const server = http.createServer((req, res) => {
    hostSeen = req.headers.host;
    if (typeof route === 'function') { route(req, res); return; }
    res.writeHead(route.status ?? 200, route.headers ?? { 'Content-Type': 'text/csv' });
    res.end(route.body ?? 'sku,stock\nA-1,5\n');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, hostSeen: () => hostSeen };
}

function pinnedTo(port: number, path = '/feed.csv') {
  return { url: new URL(`http://${UNRESOLVABLE}:${port}${path}`), address: '127.0.0.1', family: 4 };
}

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe('which addresses count as private', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['0.0.0.0', 'this host'],
    ['10.1.2.3', 'private class A'],
    ['172.16.0.1', 'private class B, low edge'],
    ['172.31.255.254', 'private class B, high edge'],
    ['192.168.1.1', 'private class C'],
    ['169.254.169.254', 'cloud metadata — the one that leaks credentials'],
    ['100.64.0.1', 'CGNAT'],
    ['::1', 'IPv6 loopback'],
    ['fd00::1', 'IPv6 unique-local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback — the spelling that gets forgotten'],
  ])('%s is private (%s)', (ip) => {
    expect(ipIsPrivate(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.255.255', '2606:4700::1'])(
    '%s is public',
    (ip) => { expect(ipIsPrivate(ip)).toBe(false); },
  );
});

describe('vetting the URL a seller typed', () => {
  it.each([
    ['ftp://example.com/feed.csv', 'bad-url'],
    ['file:///etc/passwd', 'bad-url'],
    ['not a url', 'bad-url'],
    ['http://localhost/feed.csv', 'blocked-host'],
    ['http://anything.local/feed.csv', 'blocked-host'],
    ['http://svc.internal/feed.csv', 'blocked-host'],
    ['http://127.0.0.1/feed.csv', 'blocked-host'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked-host'],
    ['http://10.0.0.5/feed.csv', 'blocked-host'],
    ['http://[::1]/feed.csv', 'blocked-host'],
  ])('%s is refused as %s', async (url, code) => {
    await expect(assertSafeUrl(url)).rejects.toThrow(code);
    // …and refused the same way through the public entry point, which swallows the throw.
    expect(await fetchFeedCsv(url)).toEqual({ ok: false, error: code });
  });

  it('accepts a public literal address without resolving anything', async () => {
    // A literal needs no lookup, and must not get one: `dns.lookup` on an IP string succeeds by
    // echoing it back, which would work while hiding that nothing was ever resolved.
    expect(await assertSafeUrl('http://8.8.8.8/feed.csv')).toMatchObject({ address: '8.8.8.8', family: 4 });
  });

  it('carries the vetted address out, so the caller has something to pin to', async () => {
    const target = await assertSafeUrl('https://93.184.216.34/inventory.csv');
    expect(target.address).toBe('93.184.216.34');
    expect(target.url.protocol).toBe('https:');
  });
});

describe('the pin is what dials', () => {
  it('connects to a host no resolver can answer for', async () => {
    const { port, hostSeen } = await serve({ body: 'sku,stock\nA-1,5\n' });

    const result = await fetchPinned(pinnedTo(port));

    // Reaching the server at all is the assertion: `.invalid` has no address, so the socket can only
    // have been dialled from the pin.
    expect(result).toEqual({ ok: true, csv: 'sku,stock\nA-1,5\n' });
    // And the pin changed only the address. The request still names the hostname, which is what
    // keeps virtual hosting working — and, over TLS, what SNI carries and the certificate is checked
    // against. Dialling `http://127.0.0.1:PORT` directly would have broken all of that.
    expect(hostSeen()).toBe(`${UNRESOLVABLE}:${port}`);
  });

  it('SABOTAGE: the same request without the pin cannot resolve the host', async () => {
    const { port } = await serve({ body: 'x' });
    const failed = await new Promise<string>((resolve) => {
      const req = http.request(`http://${UNRESOLVABLE}:${port}/feed.csv`, { agent: false }, () => resolve('connected'));
      req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
      req.end();
    });
    // If this ever reads 'connected', the test above proves nothing and the pin is not what dialled.
    expect(failed).toMatch(/ENOTFOUND|EAI_AGAIN/);
  });

  it('hands the pinned address to the socket in both lookup shapes', () => {
    // Node calls `lookup` with `all:true` or without it depending on the connect options, and a hook
    // that answers only one shape fails silently on the other.
    const lookup = pinnedLookup('203.0.113.7', 4);
    const single = new Promise((resolve) => lookup('whatever.invalid', {}, (_e, a, f) => resolve([a, f])));
    const all = new Promise((resolve) => lookup('whatever.invalid', { all: true }, (_e, a) => resolve(a)));
    return Promise.all([
      expect(single).resolves.toEqual(['203.0.113.7', 4]),
      expect(all).resolves.toEqual([{ address: '203.0.113.7', family: 4 }]),
    ]);
  });
});

describe('what the response is allowed to be', () => {
  it('refuses a redirect instead of following it', async () => {
    // The classic way around a resolved-IP check: answer 302 from a public URL with an internal
    // Location. Following it would need the whole vetting repeated on a destination the seller never
    // entered, so a 3xx is simply not a successful response.
    const { port } = await serve({ status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
    expect(await fetchPinned(pinnedTo(port))).toEqual({ ok: false, error: 'http-error' });
  });

  it('reports a non-2xx as http-error', async () => {
    const { port } = await serve({ status: 404, body: 'nope' });
    expect(await fetchPinned(pinnedTo(port))).toEqual({ ok: false, error: 'http-error' });
  });

  it('stops a body that grows past the cap, mid-stream', async () => {
    // The cap binds on what ARRIVES, never on a declared Content-Length: a header is a claim
    // (memory `project_request_body_cap`). This server declares nothing and keeps writing.
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      let sent = 0;
      const pump = (): void => {
        while (sent <= MAX_FEED_BYTES + chunk.length) {
          sent += chunk.length;
          if (!res.write(chunk)) { res.once('drain', pump); return; }
        }
        res.end();
      };
      pump();
    });
    expect(await fetchPinned(pinnedTo(port))).toEqual({ ok: false, error: 'too-large' });
  });

  it('reports an unreachable port rather than throwing', async () => {
    const { port } = await serve({ body: 'x' });
    // Close it, then aim at the now-dead port.
    await new Promise<void>((resolve) => servers[servers.length - 1]!.close(() => resolve()));
    expect(await fetchPinned(pinnedTo(port))).toEqual({ ok: false, error: 'unreachable' });
  });

  it('does not ask for a compressed body', async () => {
    // No Accept-Encoding means an identity response, which is what lets the byte cap above mean
    // anything: a gzip bomb is small on the wire and expands past the cap only after it is accepted.
    let seen: string | undefined = 'unset';
    const { port } = await serve((req, res) => {
      seen = req.headers['accept-encoding'];
      res.writeHead(200); res.end('sku\n');
    });
    await fetchPinned(pinnedTo(port));
    expect(seen).toBeUndefined();
  });
});
