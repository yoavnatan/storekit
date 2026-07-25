import dns from 'node:dns/promises';
import net from 'node:net';

// The "sync now" pull fetches a URL the SELLER supplied — a classic SSRF vector: a malicious value
// could point at the loopback interface, a private-network service, or the cloud metadata endpoint
// (169.254.169.254) to exfiltrate credentials. So every URL is validated (protocol + resolved IP)
// before we fetch it, redirects are refused (a public URL could 302 to an internal one), and the
// response is bounded in time and size. Known residual gap: DNS-rebinding between the resolve check
// and the fetch — acceptable for this manual, seller-authenticated, low-frequency action; pin the
// resolved IP if/when this moves to an unattended scheduler.

export type FeedFetchError =
  | 'bad-url' | 'blocked-host' | 'dns' | 'unreachable' | 'too-large' | 'http-error' | 'timeout';

export interface FeedFetchResult {
  ok: boolean;
  csv?: string;
  error?: FeedFetchError;
}

const MAX_FEED_BYTES = 8 * 1024 * 1024; // 8MB — generous vs. the 5000-row import cap, guards memory.
const FEED_TIMEOUT_MS = 15_000;

function ipIsPrivate(ip: string): boolean {
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

async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new FeedUrlError('bad-url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FeedUrlError('bad-url');

  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new FeedUrlError('blocked-host');
  if (net.isIP(host) && ipIsPrivate(host)) throw new FeedUrlError('blocked-host');

  let addrs: Array<{ address: string }>;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new FeedUrlError('dns'); }
  if (!addrs.length || addrs.some((a) => ipIsPrivate(a.address))) throw new FeedUrlError('blocked-host');
  return u;
}

export async function fetchFeedCsv(raw: string): Promise<FeedFetchResult> {
  let url: URL;
  try { url = await assertSafeUrl(raw); }
  catch (e) { return { ok: false, error: e instanceof FeedUrlError ? e.code : 'bad-url' }; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'error', // a 302 to an internal URL would sidestep the resolved-IP check above
      headers: { Accept: 'text/csv, text/plain, */*' },
    });
    if (!res.ok) return { ok: false, error: 'http-error' };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_FEED_BYTES) return { ok: false, error: 'too-large' };
    return { ok: true, csv: new TextDecoder('utf-8').decode(buf) };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
