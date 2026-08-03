import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// The external-inventory pull fetches a URL the SELLER supplied — a classic SSRF vector: a malicious
// value could point at the loopback interface, a private-network service, or the cloud metadata
// endpoint (169.254.169.254) to exfiltrate credentials. So every URL is validated (protocol +
// resolved IP) before we fetch it, redirects are refused (a public URL could 302 to an internal
// one), and the response is bounded in time and size.
//
// **The address the check approved is the address we connect to (2026-08-03).** Resolving a
// hostname, deciding it is public, and then handing the same hostname to an HTTP client leaves a
// window: the client resolves it a SECOND time, and the attacker's DNS server is free to answer
// 127.0.0.1 that time round (DNS rebinding). Two resolutions, two answers, and the one that was
// checked is not the one that was dialled. That gap was written down as an accepted risk while this
// ran only as a seller-authenticated button press — a human, a few times a day. Stage 4a puts it on
// a timer with nobody watching (DB_MIGRATION_PLAN.md §8, GO_LIVE §6.1), which is precisely the
// unattended, repeating, retryable condition a rebinding attack needs, so the gap is closed first.
//
// Closing it is what forced this module off `fetch`: the pin is a `lookup` hook on the socket, and
// Node's `fetch` has no supported way to pass one (its dispatcher option needs the `undici` package,
// which is not a dependency here). `http.request`/`https.request` take `lookup` natively, and going
// through them buys three other things this needed anyway — the size cap can abort mid-stream
// instead of buffering first and measuring after, a redirect can be refused without an exception,
// and no `Accept-Encoding` is sent, so a compressed bomb cannot expand past the cap after the fact.
// TLS is unaffected: the hostname is still what SNI carries and what the certificate is verified
// against, because only address resolution is overridden.

export type FeedFetchError =
  | 'bad-url' | 'blocked-host' | 'dns' | 'unreachable' | 'too-large' | 'http-error' | 'timeout';

export interface FeedFetchResult {
  ok: boolean;
  csv?: string;
  error?: FeedFetchError;
}

export const MAX_FEED_BYTES = 8 * 1024 * 1024; // 8MB — generous vs. the 5000-row import cap, guards memory.
const FEED_TIMEOUT_MS = 15_000;

export function ipIsPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;          // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;          // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80')) return true;               // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped IPv6
  if (mapped) return ipIsPrivate(mapped[1]!);
  return false;
}

class FeedUrlError extends Error {
  constructor(public code: FeedFetchError) { super(code); }
}

/** A URL that passed every check, together with THE address it passed them at. Carrying the address
 *  forward is the whole point — see the module note on rebinding. */
export interface PinnedTarget {
  url: URL;
  address: string;
  family: number;
}

/**
 * A `lookup` that ignores the hostname and always answers with the address we already vetted.
 *
 * Overriding resolution rather than dialling the IP directly keeps everything else honest: the
 * request line, the `Host` header, SNI and the certificate check all still see the real hostname,
 * so a pinned request to an HTTPS feed verifies exactly as an unpinned one would. Rewriting the URL
 * to `https://<ip>/…` would have broken all four.
 */
export function pinnedLookup(address: string, family: number): net.LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

export async function assertSafeUrl(raw: string): Promise<PinnedTarget> {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new FeedUrlError('bad-url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FeedUrlError('bad-url');

  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new FeedUrlError('blocked-host');
  // A bracketed IPv6 literal reaches us as `[::1]` in `URL.hostname`; `net.isIP` wants it bare.
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(literal)) {
    if (ipIsPrivate(literal)) throw new FeedUrlError('blocked-host');
    // A literal address needs no resolution — and must not get one, because `dns.lookup` on an IP
    // string succeeds by echoing it back, which works but hides that no lookup is involved.
    return { url: u, address: literal, family: net.isIPv6(literal) ? 6 : 4 };
  }

  let addrs: Array<{ address: string; family: number }>;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new FeedUrlError('dns'); }
  // EVERY answer has to be public, not just the one we pick: a name that resolves to a public and a
  // private address is either misconfigured or hostile, and picking the good one would let the same
  // URL be judged differently on the next call.
  if (!addrs.length || addrs.some((a) => ipIsPrivate(a.address))) throw new FeedUrlError('blocked-host');
  const first = addrs[0]!;
  return { url: u, address: first.address, family: first.family };
}

type CappedRead = { ok: true; text: string } | { ok: false; error: FeedFetchError };

/** The response body, capped. Resolves early with `too-large` rather than buffering an unbounded
 *  stream and measuring it afterwards — the cap has to bind on what is RECEIVED, not on what a
 *  `Content-Length` header claims (memory `project_request_body_cap`: a declared length is a claim). */
function readCapped(res: http.IncomingMessage): Promise<CappedRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (value: CappedRead): void => {
      if (settled) return;
      settled = true;
      res.destroy();
      resolve(value);
    };
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_FEED_BYTES) { done({ ok: false, error: 'too-large' }); return; }
      chunks.push(chunk);
    });
    res.on('end', () => done({ ok: true, text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)) }));
    res.on('error', () => done({ ok: false, error: 'unreachable' }));
  });
}

export async function fetchFeedCsv(raw: string): Promise<FeedFetchResult> {
  let target: PinnedTarget;
  try { target = await assertSafeUrl(raw); }
  catch (e) { return { ok: false, error: e instanceof FeedUrlError ? e.code : 'bad-url' }; }
  return fetchPinned(target);
}

/**
 * The request half: everything after the address has been vetted.
 *
 * Split from `fetchFeedCsv` so the two halves can be told apart — and so they can be TESTED apart.
 * The vetting refuses every address a local test server could listen on, which is the whole point of
 * it, so the only way to exercise the HTTP behaviour (a refused redirect, the size cap, a non-2xx,
 * the deadline) against a real socket is to hand this half a target directly. That the pin is what
 * dialled is provable the same way: a hostname that resolves nowhere still connects, because the
 * address never came from a resolver. See `tests/feed-fetch-ssrf.test.ts`.
 */
export function fetchPinned(target: PinnedTarget): Promise<FeedFetchResult> {
  const { url, address, family } = target;
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise<FeedFetchResult>((resolve) => {
    let settled = false;
    const finish = (value: FeedFetchResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(value);
    };

    const req = transport.request(url, {
      lookup: pinnedLookup(address, family),
      // A fresh socket per request. The global agents keep connections alive keyed by host:port, and
      // a pooled socket would have been dialled under a DIFFERENT pin — reusing it silently undoes
      // the pin for the second request to the same host.
      agent: false,
      headers: { Accept: 'text/csv, text/plain, */*' },
    }, (res) => {
      const status = res.statusCode ?? 0;
      // Not followed, ever: a public URL answering 302 with an internal Location is the standard way
      // around a resolved-IP check, and following it would need the whole vetting repeated against a
      // destination the seller never entered. A 3xx is simply not a successful response.
      if (status < 200 || status > 299) { finish({ ok: false, error: 'http-error' }); return; }
      void readCapped(res).then((r) => finish(r.ok ? { ok: true, csv: r.text } : { ok: false, error: r.error }));
    });

    // One deadline for the whole exchange — connect, headers AND body. A socket-inactivity timeout
    // alone would never trip on a server trickling one byte a second.
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), FEED_TIMEOUT_MS);

    req.on('error', () => finish({ ok: false, error: 'unreachable' }));
    req.end();
  });
}
