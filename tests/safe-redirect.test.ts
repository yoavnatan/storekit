import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { safeRedirectPath, safeRefererPath } from '../src/lib/safe-redirect.js';

describe('safeRedirectPath', () => {
  it('keeps an ordinary in-site path, query and all', () => {
    expect(safeRedirectPath('/seller/dashboard')).toBe('/seller/dashboard');
    expect(safeRedirectPath('/checkout?step=2')).toBe('/checkout?step=2');
  });

  it('refuses a protocol-relative path — the browser reads //host as a HOST, not a path', () => {
    expect(safeRedirectPath('//evil.com')).toBe('/');
    expect(safeRedirectPath('//evil.com/looks/like/a/path')).toBe('/');
  });

  it('refuses the backslash variant browsers normalise into a protocol-relative URL', () => {
    expect(safeRedirectPath('/\\evil.com')).toBe('/');
  });

  it('refuses an absolute URL and a scheme', () => {
    expect(safeRedirectPath('https://evil.com')).toBe('/');
    expect(safeRedirectPath('javascript:alert(1)')).toBe('/');
    expect(safeRedirectPath('data:text/html,<script>')).toBe('/');
  });

  it('refuses a relative path — it resolves against whatever page happens to be current', () => {
    expect(safeRedirectPath('dashboard')).toBe('/');
    expect(safeRedirectPath('../admin')).toBe('/');
  });

  it('refuses control characters, which can truncate the Location header', () => {
    expect(safeRedirectPath('/ok\r\nSet-Cookie: a=b')).toBe('/');
    expect(safeRedirectPath('/ok\x00')).toBe('/');
  });

  it('trims surrounding whitespace rather than rejecting on it', () => {
    // A trailing space is a copy-paste artifact, not an attack — rejecting it would send a
    // legitimate return-path to the homepage for no reason.
    expect(safeRedirectPath('  /seller/dashboard ')).toBe('/seller/dashboard');
  });

  it('handles the empty/missing cases', () => {
    expect(safeRedirectPath('')).toBe('/');
    expect(safeRedirectPath(null)).toBe('/');
    expect(safeRedirectPath(undefined, '/seller/dashboard')).toBe('/seller/dashboard');
  });

  it('honours the reject list so a flow cannot bounce back to itself', () => {
    expect(safeRedirectPath('/seller/login', '/', ['/seller/login'])).toBe('/');
    // Matched on the path alone — a query string must not smuggle the loop back in.
    expect(safeRedirectPath('/seller/login?x=1', '/', ['/seller/login'])).toBe('/');
    expect(safeRedirectPath('/seller/dashboard', '/', ['/seller/login'])).toBe('/seller/dashboard');
  });
});

describe('safeRefererPath', () => {
  const origin = 'https://dezabin.co.il';

  it('follows our own referrer, keeping path + query', () => {
    expect(safeRefererPath(`${origin}/store/acme?sort=new`, origin)).toBe('/store/acme?sort=new');
  });

  it('refuses a foreign referrer — this is the /api/lang open redirect', () => {
    expect(safeRefererPath('https://evil.com/anything', origin)).toBe('/');
    // Same registrable-looking prefix, different host.
    expect(safeRefererPath('https://dezabin.co.il.evil.com/', origin)).toBe('/');
  });

  it('refuses a different scheme on the same host', () => {
    expect(safeRefererPath('http://dezabin.co.il/store', origin)).toBe('/');
  });

  it('falls back on a missing referrer', () => {
    expect(safeRefererPath(null, origin)).toBe('/');
    expect(safeRefererPath('', origin)).toBe('/');
  });

  it('never returns an off-site destination, whatever the referrer looks like', () => {
    // Garbage resolves against our own origin rather than throwing, so it stays in-site (a 404
    // at worst). The invariant is not "rejects junk" — it is "the result is always our own path".
    for (const referer of ['::::', 'not a url', '/relative', '//evil.com', 'https://evil.com/x']) {
      const result = safeRefererPath(referer, origin);
      expect(result.startsWith('/')).toBe(true);
      expect(result.startsWith('//')).toBe(false);
    }
  });
});

// The point of the helper is that no route re-implements the rule. This is what keeps the next
// redirect flow from being written the old way — the check used to be copy-pasted into four
// routes and simply absent from a fifth, which is how the /api/lang open redirect existed.
describe('no route hand-rolls the redirect check', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  }

  it('leaves the protocol-relative check to lib/safe-redirect.ts', () => {
    const offenders = walk('src/pages')
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => readFileSync(f, 'utf8').includes("startsWith('//')"));
    expect(offenders).toEqual([]);
  });

  it('never sends a Referer header straight into a Location', () => {
    const offenders = walk('src/pages')
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return /headers\.get\(['"]referer['"]\)/i.test(src) && !src.includes('safeRefererPath');
      });
    expect(offenders).toEqual([]);
  });
});
