import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripTrailingSlashes, trimDashes, urlSegment } from '../src/lib/url-base.js';

/** Every .ts/.astro under src — shared by the two "nobody hand-rolls this" guards below. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

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

describe('urlSegment', () => {
  it('percent-encodes a Hebrew slug — the common case on this site', () => {
    expect(urlSegment('חולצה-כחולה')).toBe('%D7%97%D7%95%D7%9C%D7%A6%D7%94-%D7%9B%D7%97%D7%95%D7%9C%D7%94');
  });

  it('round-trips back to the stored slug, which is how the route matches it', () => {
    for (const slug of ['חולצה-כחולה', 'blue-shirt', 'שמלה2', 'מוצר-123']) {
      expect(decodeURIComponent(urlSegment(slug))).toBe(slug);
    }
  });

  it('leaves an ASCII slug byte-identical, so no existing URL moves', () => {
    expect(urlSegment('blue-shirt-2')).toBe('blue-shirt-2');
  });

  it('escapes path structure rather than emitting it — one segment stays one segment', () => {
    expect(urlSegment('a/b')).toBe('a%2Fb');
    expect(urlSegment('a?b#c')).toBe('a%3Fb%23c');
  });
});

describe('trimDashes', () => {
  it('trims both edges and leaves the interior alone', () => {
    expect(trimDashes('--חולצה-כחולה--')).toBe('חולצה-כחולה');
    expect(trimDashes('blue-shirt')).toBe('blue-shirt');
    expect(trimDashes('---')).toBe('');
    expect(trimDashes('')).toBe('');
  });

  it('is LINEAR on the input that makes the regex form quadratic', () => {
    // `^-+|-+$` measured 65ms at 8k interior dashes and 4.7s at 64k — a product name and a store
    // slug both arrive with a request, so that is an SSR stall, not a slow function.
    const hostile = `a${'-'.repeat(120_000)}a`;
    const t0 = Date.now();
    expect(trimDashes(hostile)).toBe(hostile);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe('nothing hand-rolls the dash trim', () => {
  it('leaves it to lib/url-base.ts', () => {
    // The anchored-quantifier form is quadratic (see trimDashes). It was hand-rolled in four
    // places; two were safe only by line order and two were genuinely vulnerable.
    const offenders = walk('src')
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => !f.endsWith(join('lib', 'url-base.ts')))
      .filter((f) => /replace\(\/\^-\+\|-\+\$\//.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('nothing hand-rolls the trailing-slash strip', () => {
  it('leaves it to lib/url-base.ts', () => {
    const offenders = walk('src')
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => !f.endsWith(join('lib', 'url-base.ts')))
      .filter((f) => readFileSync(f, 'utf8').includes('replace(/\\/+$/'));
    expect(offenders).toEqual([]);
  });
});
