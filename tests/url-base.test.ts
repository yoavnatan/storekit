import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripTrailingSlashes } from '../src/lib/url-base.js';

describe('stripTrailingSlashes', () => {
  it('trims one slash or many, and leaves interior slashes alone', () => {
    expect(stripTrailingSlashes('https://dezabin.com/')).toBe('https://dezabin.com');
    expect(stripTrailingSlashes('https://dezabin.com///')).toBe('https://dezabin.com');
    expect(stripTrailingSlashes('/store/product/')).toBe('/store/product');
    expect(stripTrailingSlashes('/a//b/')).toBe('/a//b');
  });

  it('leaves a string with no trailing slash untouched', () => {
    expect(stripTrailingSlashes('/store/product')).toBe('/store/product');
    expect(stripTrailingSlashes('')).toBe('');
  });

  it('reduces an all-slashes path to empty, which callers turn back into "/"', () => {
    // Seo.astro relies on this: `stripTrailingSlashes(pathname) || '/'`. A request for "///" must
    // produce the root canonical, not an empty href.
    expect(stripTrailingSlashes('///')).toBe('');
  });

  // Why this helper exists at all. `pathname.replace(/\/+$/, '')` is quadratic, and Seo.astro runs
  // it on the raw request path of every SSR render — 64k slashes measured at 4.3s, which on
  // single-threaded SSR is the whole server, not one slow response.
  it('stays instant on a path that is nothing but slashes', () => {
    const hostile = '/'.repeat(200_000) + 'x';
    const started = process.hrtime.bigint();
    expect(stripTrailingSlashes(hostile)).toBe(hostile);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe('nothing hand-rolls the trailing-slash strip', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  }

  it('leaves it to lib/url-base.ts', () => {
    const offenders = walk('src')
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => !f.endsWith(join('lib', 'url-base.ts')))
      .filter((f) => readFileSync(f, 'utf8').includes('replace(/\\/+$/'));
    expect(offenders).toEqual([]);
  });
});
