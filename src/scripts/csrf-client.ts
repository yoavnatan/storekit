/**
 * Attaching the CSRF token to everything this application sends — in ONE place, by wrapping
 * `fetch`, rather than at the ~130 call sites that would each have to remember.
 *
 * The rule this enforces is `src/lib/csrf.ts`'s; the reason it is a wrapper and not a helper is
 * the repo's own history with rules that live at call sites (safe-redirect.ts, secret-compare.ts:
 * both were correct in most places and missing from one). A helper every mutating fetch is
 * supposed to import is a helper the next one will not. There is nothing to remember here.
 *
 * **Loaded from `BaseLayout.astro`'s `<head>`, and the position is load-bearing.** Bundled
 * `<script>` tags are `type="module"`, i.e. deferred and executed in document order, so a module in
 * the head runs before every other module on the page — including the ones that fetch on load
 * (cart-sync, the error reporter). The only scripts that run earlier are `is:inline`, and none of
 * those sends a mutating request.
 *
 * The token itself comes from the `<meta>` tag, not from a cookie: keeping it out of a cookie means
 * there is no JS-readable cookie to steal and no "cookie tossing" from a neighbouring host to
 * worry about, since the server verifies the SIGNATURE rather than comparing against a cookie.
 *
 * The two names are imported, never re-typed: `lib/csrf.ts` cannot be imported here (it pulls in
 * node:crypto and the database pool), so the strings lived in both files — and renaming the header
 * on the server would have turned every mutating request into a silent 403. `lib/csrf-names.ts`
 * has no imports of its own, so this side can share them for the cost of two strings.
 */
import { CSRF_HEADER, CSRF_META } from '../lib/csrf-names.js';


const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function token(): string {
  return document.querySelector<HTMLMetaElement>(`meta[name="${CSRF_META}"]`)?.content ?? '';
}

/** The URL a fetch argument actually addresses, resolved against the page so a relative
 *  `/api/store` is comparable with an absolute Cloudinary URL. */
function targetUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === 'string') return new URL(input, location.href);
    if (input instanceof URL) return input;
    return new URL(input.url, location.href);
  } catch {
    return null;
  }
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

export function initCsrf(): void {
  const original = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = targetUrl(input);
    // Same-origin only. The token is a credential for OUR server; adding it to a Cloudinary
    // upload or an analytics beacon would hand it to a third party for nothing.
    const mine = !!url && url.origin === location.origin;
    if (!mine || SAFE_METHODS.has(methodOf(input, init))) return original(input, init);

    // Seeded from whichever side already carries headers, so a caller's own Content-Type and
    // Authorization survive. `fetch(input, init)` builds `new Request(input, init)`, which means
    // method and body still come from `input` when it is a Request — only the headers are ours.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(CSRF_HEADER, token());
    return original(input, { ...init, headers });
  };
}
