/**
 * Server-side validation for every image URL that enters the app from a request.
 *
 * The rendering layer escapes what it prints, but escaping is the LAST line, not
 * the only one: a stored value that isn't a URL at all has no business reaching
 * the data files, and one missed escape then becomes stored XSS. Both halves of
 * this class were live until 2026-07-29 — `parseImages` took `form.getAll('images')`
 * verbatim (any string a seller cared to POST), and `brand-campaigns.ts` accepted
 * anything with an `https://` PREFIX, which `https://x" onerror=alert(1)` satisfies.
 *
 * Two rules, both enforced by re-serializing rather than by pattern-matching:
 *
 *   1. **Shape, not host.** An https:// absolute URL or a site-relative `/path`.
 *      Deliberately NOT an allowlist of hosts: uploads are Cloudinary today, but
 *      the seeded demo catalogue is a third-party CDN and a future catalogue
 *      import will bring more — a host list would silently drop those and force a
 *      config knob. Shape validation already removes the injection vector, which
 *      is the actual security goal.
 *   2. **Normalized output, not the input string.** The value stored is the URL
 *      parser's own serialization, so `"`, `<`, `>`, backtick and space come back
 *      percent-encoded. That is what makes an attribute breakout impossible even
 *      if some future call site forgets to escape — the stored value can no longer
 *      contain the character that closes an attribute.
 *
 * Rejected by construction: `javascript:`, `data:`, `blob:`, `vbscript:`, plain
 * `http://` (every real source here is TLS), and protocol-relative `//host/x`
 * (a remote URL wearing a relative path's clothes).
 */

/** Long enough for a Cloudinary URL carrying a transform chain, short enough that
 *  a runaway paste can't bloat the JSON store. */
const MAX_URL_LENGTH = 2048;

/** Only used to resolve a site-relative path so the URL parser will normalize it;
 *  never part of the returned value. */
const RELATIVE_BASE = 'https://relative.invalid';

/**
 * Returns the normalized URL, or `null` when the input is not a usable image URL.
 * Never throws — a malformed string is a `null`, not a 500.
 */
export function sanitizeImageUrl(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > MAX_URL_LENGTH) return null;

  // Protocol-relative (`//evil.example/x.png`) resolves to a REMOTE url against
  // the page's scheme while looking like a path — rejected before anything else,
  // since the site-relative branch below would otherwise be reached by it.
  if (value.startsWith('//')) return null;

  if (value.startsWith('/')) {
    try {
      const url = new URL(value, RELATIVE_BASE);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch { return null; }
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return url.href;
  } catch { return null; }
}

/**
 * The feed form: the same validation, but resolved to an ABSOLUTE URL.
 *
 * `sanitizeImageUrl` deliberately keeps a site-relative `/path` as a path (rule 1
 * above) — correct for storage and for rendering a page, wrong for a product feed:
 * Google Merchant Center and Meta Catalog reject a row whose `image_link` isn't
 * absolute, and they reject it silently, so a seller's product would just quietly
 * stop being advertised. Resolving against the feed's own origin keeps the product
 * IN the feed instead of dropping it over a spelling the app itself accepts.
 *
 * Returns `null` for anything the validator rejects, or when `baseUrl` isn't a
 * usable origin — the caller skips that image rather than emitting a broken row.
 */
export function toAbsoluteImageUrl(raw: unknown, baseUrl: string): string | null {
  const url = sanitizeImageUrl(raw);
  if (url === null) return null;
  if (!url.startsWith('/')) return url; // already absolute — sanitize guarantees https://
  try {
    return new URL(url, baseUrl).href;
  } catch { return null; }
}

/** The list form: drops every entry that isn't a usable image URL, keeping order
 *  and de-duplicating (two spellings of one URL normalize to the same string). */
export function sanitizeImageUrls(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const url = sanitizeImageUrl(item);
    if (url && !seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}
