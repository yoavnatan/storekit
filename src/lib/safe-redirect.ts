// safe-redirect — the one place that decides whether a request-supplied destination may be
// redirected to.
//
// Every "come back here afterwards" flow carries a destination the request controls: `?next=`
// on login/register/logout, the `oauth_next` cookie on the Google callback, the `Referer` on
// the language switch. Unchecked, any of them turns our own URL into a redirector to someone
// else's site — the user clicks a link on our domain, our server sends them off, and the
// address bar never showed anything suspicious. That is a phishing primitive, not a cosmetic
// bug, and the destination is never something we need to be liberal about: every legitimate
// one of these is a path on this site.
//
// The rule is deliberately narrow — an absolute path, and nothing else:
//   `/seller/dashboard`  ✓
//   `//evil.com`         ✗ protocol-relative; the browser reads it as a HOST, not a path
//   `https://evil.com`   ✗
//   `javascript:…`       ✗
//   `dashboard`          ✗ relative — resolves against whatever the current path happens to be
//
// Until 2026-07-29 these three lines were copy-pasted into four routes and simply absent from
// a fifth (`/api/lang`, which trusted `Referer` — an off-site value by definition). One shared
// function is what stops the next flow from being the sixth. Guarded by tests/safe-redirect.test.ts.

import { machineUrl } from './url-base.js';

/**
 * A path safe to redirect to, or `fallback` when the candidate is anything else.
 *
 * @param raw       the untrusted candidate (query param, cookie, header)
 * @param fallback  where to go instead — must itself be an in-site absolute path
 * @param reject    paths to refuse even though they are well-formed, so a flow can avoid
 *                  bouncing back to itself (login → login → login)
 */
export function safeRedirectPath(raw: string | null | undefined, fallback = '/', reject: string[] = []): string {
  if (typeof raw !== 'string') return fallback;
  const candidate = raw.trim();
  if (!candidate.startsWith('/')) return fallback;
  // Protocol-relative (`//host`) and the backslash variant browsers normalise to it (`/\host`)
  // both leave this origin while looking path-shaped. Checked on the RAW candidate as well as on
  // the encoded one below: `//evil.example/x` parses as a host plus a path, so encoding alone would
  // silently REPAIR it into `/x` and redirect somewhere the caller never asked for, instead of
  // refusing a destination that was hostile as written.
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return fallback;
  // A control character can truncate the Location header; a well-formed path never holds one.
  // eslint-disable-next-line no-control-regex -- matching control characters IS the check here
  if (/[\x00-\x1f\x7f]/.test(candidate)) return fallback;
  // Percent-encoded FIRST, then judged — and the order is the security property, not a detail.
  // Every caller puts this straight into a `Location`, where a character above U+00FF makes the
  // `Response` constructor throw instead of redirecting (url-base.ts#machineUrl); `?next=` arrives
  // DECODED from `searchParams.get`, and on this catalogue "the page you were on" is a Hebrew path.
  // But encoding also RESOLVES dot segments, and that can turn a path-shaped candidate into an
  // off-site one: `/..//evil.example` starts with `/.`, so it passes a raw `//` check, and
  // normalises to `//evil.example` — which a browser reads as a HOST. Judging the encoded value is
  // what closes that, and it also means `/seller/./login` can no longer walk around `reject`.
  const encoded = machineUrl(candidate);
  if (!encoded.startsWith('/') || encoded.startsWith('//') || encoded.startsWith('/\\')) return fallback;
  if (reject.includes(encoded.split('?')[0] ?? encoded)) return fallback;
  return encoded;
}

/**
 * The same decision for a `Referer` header, which arrives as an absolute URL rather than a path.
 * Only this origin's own referrers are honoured, and only their path+query survives — so a
 * cross-site referrer degrades to `fallback` instead of becoming a redirect off the site.
 */
export function safeRefererPath(referer: string | null | undefined, origin: string, fallback = '/'): string {
  if (!referer) return fallback;
  let url: URL;
  try {
    url = new URL(referer, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin) return fallback;
  return safeRedirectPath(url.pathname + url.search, fallback);
}
