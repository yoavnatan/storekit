/**
 * The "לנסות שוב" link on `500.astro` points at the url that just failed — which makes it a
 * request-supplied destination in an `href`, the same class `lib/safe-redirect.ts` exists for, only
 * arriving by a route nobody thinks of as user input.
 *
 * **Why it is reachable.** `Astro.url.pathname` looks obviously safe: it always starts with `/`. But
 * a request for `//evil.example` parses to exactly that pathname, and `href="//evil.example"` is
 * protocol-relative — the browser reads it as a HOST, not a path. Escaping does not help; the value
 * is a perfectly well-formed attribute. And the page is reachable by making any request fail, so the
 * attacker picks the url: a link on our domain, our error page, one click off the site.
 *
 * Two tests, because they fail differently. The first pins the SHAPE — that the page hands the url
 * to the shared checker at all — since the way this regresses is someone inlining `Astro.url` again
 * during an unrelated edit. The second pins the BEHAVIOUR of the decision for the exact inputs a
 * failing request can produce, so the guarantee is proven rather than delegated on faith.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeRedirectPath } from '../src/lib/safe-redirect.js';

describe('500 page retry link', () => {
  const source = readFileSync(join(process.cwd(), 'src/pages/500.astro'), 'utf8');

  it('routes the failed url through safe-redirect rather than into the href directly', () => {
    expect(source).toContain('safeRedirectPath(Astro.url.pathname + Astro.url.search)');
    expect(source).toContain('href={retryHref}');
    // The inlined form is the bug this file is about; it must not come back alongside the fix.
    expect(source).not.toContain('href={Astro.url.pathname');
  });

  it('refuses every off-site shape a failing request can produce', () => {
    // Pathnames as `new URL()` actually reports them for these requests.
    expect(safeRedirectPath('//evil.example')).toBe('/');
    expect(safeRedirectPath('//evil.example/looks/like/a/path')).toBe('/');
    expect(safeRedirectPath('/\\evil.example')).toBe('/');
    // Path-shaped until it normalises: passes a naive `//` check, resolves to a host.
    expect(safeRedirectPath('/..//evil.example')).toBe('/');
  });

  it('still returns a real visitor to the page that failed', () => {
    // The guard is worthless if it sends everyone home — retrying the actual request is the point.
    expect(safeRedirectPath('/checkout')).toBe('/checkout');
    expect(safeRedirectPath('/some-store/product-x?variant=2')).toBe('/some-store/product-x?variant=2');
    // Hebrew slugs are the normal case on this catalogue (project rule: slugs keep Hebrew), and they
    // come back percent-encoded — still the same page.
    expect(safeRedirectPath('/חנות/מוצר')).toBe('/' + encodeURIComponent('חנות') + '/' + encodeURIComponent('מוצר'));
  });
});
