import { serverEnv } from './runtime-env.js';

/**
 * The caller's address, for rate limiting only.
 *
 * **A forwarded-for header is a claim, not a fact** — the same class as `Content-Length` in
 * `lib/request-body.ts` and the `Referer` that let `/api/lang` redirect off-site. Anyone can send
 * `X-Forwarded-For: 1.2.3.4` directly to the origin, so trusting it unconditionally would hand an
 * attacker a fresh rate-limit bucket per request: the one header that exists to identify them
 * becomes the one they control.
 *
 * Which is why it is trusted only when `TRUST_PROXY_IP` is set, i.e. when the operator has
 * confirmed the app is reachable ONLY through a proxy that overwrites the header. Get this backwards
 * and one of two things breaks quietly:
 *   • trusted when it should not be → per-IP limits are bypassed at will (spoofable bucket);
 *   • not trusted when it should be → every request appears to come from the proxy, so all sellers
 *     share ONE bucket and the per-origin limit locks out the whole platform at once.
 * The second is why the per-identity bucket in `rate-limit.ts` is the primary defence and the
 * per-origin one is deliberately loose — a misconfiguration degrades, it does not lock everyone out.
 *
 * `GO_LIVE_CHECKLIST.md` §1 carries the row for setting this when hosting goes up.
 *
 * The socket address (`Astro.clientAddress`) is the fallback and needs no trust: the node adapter
 * reads it from the connection, and nothing in the request can change it.
 */
export function clientIp(request: Request, socketAddress: string | undefined): string {
  if (serverEnv('TRUST_PROXY_IP')) {
    // Cloudflare's own header first — it is set by the edge and cannot be forged past it, and this
    // platform's DNS already sits on Cloudflare for one of the two domains (GO_LIVE §1).
    const cf = request.headers.get('cf-connecting-ip');
    if (cf) return normalise(cf);
    // Left-most entry: proxies APPEND, so the original client is first and everything after it is
    // the hop chain. (Left-most is also the attacker-controlled one when the header is not
    // overwritten by the edge — hence the env gate above.)
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return normalise(first);
    }
  }
  return normalise(socketAddress) || 'unknown';
}

/** IPv6-mapped IPv4 (`::ffff:1.2.3.4`) and a plain `1.2.3.4` are the same caller and must share one
 *  bucket. Capped because the value ends up in a primary key, and an oversized header should cost a
 *  truncated bucket, not a failed insert. */
function normalise(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim().replace(/^::ffff:/i, '');
  return trimmed.slice(0, 45);
}
