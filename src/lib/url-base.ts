// Trailing-slash trimming, in one place and in linear time.
//
// The obvious `value.replace(/\/+$/, '')` is quadratic: for a string of N slashes that never
// satisfies the anchor, the engine retries the run from every position. Measured at introduction,
// 64k slashes took 4.3 seconds — and one of the callers below feeds it `Astro.url.pathname`, which
// is whatever the request line said. On single-threaded SSR that is the whole server stalling, so
// this scans backwards once instead.

const SLASH = '/'.charCodeAt(0);

/** `value` without its trailing slashes. Linear in the input, whatever the input. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH) end--;
  return value.slice(0, end);
}

const DASH = '-'.charCodeAt(0);

/**
 * `value` without leading/trailing dashes — a slug's edge trim, in linear time.
 *
 * The obvious `value.replace(/^-+|-+$/g, '')` is the same quadratic trap as the trailing-slash
 * strip above, for the same reason: `-+$` matches a run, fails the anchor, backtracks, and retries
 * from every position. Measured 2026-08-02 on a run of interior dashes — 8k took 65ms, 64k took
 * **4.7 seconds**. It was hand-rolled in four places: two server-side (store + product slug
 * generation, fed a name that arrives with the request — an SSR stall) and two in the dashboard's
 * live URL preview, which ran it on every keystroke against the raw input field.
 *
 * Both server call sites happened to be safe only because they collapse runs to a single dash
 * FIRST — safety as a property of line order, one refactor away from a 4.7-second stall. The two
 * client ones had no such collapse and were genuinely vulnerable to a pasted value.
 */
export function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === DASH) start++;
  while (end > start && value.charCodeAt(end - 1) === DASH) end--;
  return value.slice(start, end);
}

/**
 * One store/product slug, percent-encoded for a URL that will be READ BY A MACHINE.
 *
 * Slugs carry Hebrew (store-products.ts#slugify) because that is the site's language and its
 * strongest keyword signal. A browser encodes a Hebrew `href` by itself, so ordinary in-page links
 * need nothing — but a URL we hand to a parser does: the sitemap spec requires escaped entities in
 * `<loc>`, Merchant Center validates `<link>` as a URL, and a canonical/og:url that disagrees with
 * the encoded form Google actually fetched is a canonical pointing at a different page than the one
 * it is on.
 *
 * `encodeURIComponent` and not `encodeURI`: this encodes ONE segment, so `/`, `?` and `#` must come
 * out escaped rather than being read as structure. A slug can't contain them today — slugify keeps
 * only letters, digits and `-` — which is exactly why encoding a segment can never corrupt the path
 * it sits in.
 */
export function urlSegment(slug: string): string {
  return encodeURIComponent(slug);
}
