/**
 * The three names the CSRF token travels under — in ONE place, because the two ends of it live in
 * different runtimes and cannot import each other.
 *
 * `lib/csrf.ts` is the server half and pulls in `node:crypto`, the session modules and the database
 * pool; `scripts/csrf-client.ts` runs in the browser and can import none of that. So the header and
 * meta names were written out twice, once on each side — and a rename on the server would then have
 * turned every mutating request on the site into a silent 403, with the two literals sitting in
 * files nobody would think to read together. That is this repo's most repeated bug class
 * (safe-redirect, secret-compare), and the cheapest possible instance of it.
 *
 * This module holds string constants and nothing else — no imports, no side effects — so the
 * browser bundle pays three strings for the guarantee.
 */

/** The request header an AJAX caller carries the token in (`scripts/csrf-client.ts` sets it). */
export const CSRF_HEADER = 'x-csrf-token';

/** The hidden field name, for the forms the browser really submits (`components/CsrfField.astro`). */
export const CSRF_FIELD = '_csrf';

/** The `<meta name>` BaseLayout renders the token into — the client's only source for it. */
export const CSRF_META = 'csrf-token';
