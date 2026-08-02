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
 * What a slug may hold, applied to raw text: letters in ANY script, digits, hyphen — plus
 * whitespace, which `toSlug` turns into hyphens and the live-typing fields keep so a word break
 * survives until the seller finishes typing it.
 *
 * **NFKC first, and that is the load-bearing part.** A slug is an IDENTITY here — stores are
 * unique by it, orders key `storeSubtotals` by it, and `orders.ts#orderBelongsToStore` decides
 * who may touch an order by comparing it. Unicode can spell one Hebrew word more than one way
 * (a presentation-form letter like U+FB2E vs the plain letter, niqqud composed vs decomposed),
 * and without folding those to one spelling, two stores could hold slugs that are byte-different
 * and pixel-identical — a free impersonation, and a lookup that misses its own record when a
 * link arrives spelled the other way. NFKC settles on one spelling before anything else runs.
 *
 * Marks (niqqud, U+05B0–U+05C7) are neither `\p{L}` nor `\p{N}`, so they drop out here — עִבְרִית
 * and עברית reach the same slug, which is what a reader typing the URL expects.
 */
export function slugChars(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '');
}

/**
 * Characters, not code units — see toSlug. Generous for a real name (a wordy Hebrew product runs
 * ~40) and still a bound: a slug is written into every order, cart and analytics row that references
 * the store, and into every sitemap `<loc>` and feed `<link>`, where Hebrew percent-encodes to six
 * characters per letter. Nothing capped the seller-POSTed value before; allowing Hebrew is what
 * made an uncapped one six times heavier.
 */
const SLUG_MAX = 120;

/**
 * Free text → a finished slug: the server's rule, and the ONE definition. `stores.ts#normalizeSlug`
 * and `store-products.ts#slugify` are both this function — they were two near-copies that had
 * already drifted (one accepted Hebrew, the other silently threw it away and numbered the product).
 *
 * The live-typing fields deliberately call `slugChars` alone instead: this trims edge hyphens, and
 * doing that per keystroke eats the `-` the moment the seller types it in `my-store`.
 */
export function toSlug(input: string): string {
  const collapsed = slugChars(input).trim().replace(/\s+/g, '-').replace(/-+/g, '-');
  // Spread, not slice(0, N): a code unit is not a character, and `\p{L}` admits scripts outside the
  // BMP — a raw slice can cut a surrogate pair in half and leave a lone half in the store's identity.
  const capped = [...collapsed].slice(0, SLUG_MAX).join('');
  // Trim AFTER the cap: cutting mid-word can land exactly on a hyphen and leave a trailing one.
  return trimDashes(capped);
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
