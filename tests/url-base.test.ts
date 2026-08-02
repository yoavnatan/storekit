import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripTrailingSlashes, trimDashes, urlSegment, slugChars, toSlug } from '../src/lib/url-base.js';

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

describe('toSlug — the one slug rule, shared by stores and products', () => {
  it('keeps letters in any script, so a Hebrew name is a Hebrew slug', () => {
    expect(toSlug('חנות הבגדים')).toBe('חנות-הבגדים');
    expect(toSlug('My Store')).toBe('my-store');
    expect(toSlug('חנות ABC 2')).toBe('חנות-abc-2');
  });

  it('drops everything a path must never carry', () => {
    // `/`, `?`, `#`, `%`, `.` and the invisible RLM a Hebrew paste brings along are none of them
    // a letter or a number, so the class removes them without naming them one by one.
    expect(toSlug('a/b?c#d%e.f')).toBe('abcdef');
    expect(toSlug('חנות‏')).toBe('חנות');
  });

  it('trims edge hyphens and collapses runs', () => {
    expect(toSlug('  --my   store--  ')).toBe('my-store');
  });

  it('returns empty when nothing usable remains — the caller decides what that means', () => {
    expect(toSlug('!!!')).toBe('');
    expect(toSlug('   ')).toBe('');
  });

  // The identity half. A slug decides which store an order belongs to (orders.ts#orderBelongsToStore)
  // and keys storeSubtotals, so two spellings of one word must never become two stores.
  it('folds the Unicode spellings of one Hebrew word onto a single slug', () => {
    const presentationForm = 'אַון';        // אַ as one precomposed char + ון
    const plain = 'און';                    // the same word, plain letters
    expect(toSlug(presentationForm)).toBe(toSlug(plain));
    // Niqqud are marks, not letters — עִבְרִית and עברית address the same page.
    expect(toSlug('עִבְרִית')).toBe(toSlug('עברית'));
  });

  it('slugChars keeps whitespace so live typing does not eat a word break', () => {
    // The field calls slugChars alone; toSlug's edge trim would delete the `-` in "my-store"
    // the moment the seller types it.
    expect(slugChars('my store')).toBe('my store');
    expect(toSlug('my-')).toBe('my');
  });

  it('caps length on a character boundary, and never on a trailing hyphen', () => {
    expect(toSlug('a'.repeat(500))).toHaveLength(120);
    expect(toSlug('חנות '.repeat(200)).length).toBeLessThanOrEqual(120);
    expect(toSlug('ab-'.repeat(200)).endsWith('-')).toBe(false);
    // A slice by code unit would leave half a surrogate pair in the store's identity.
    const astral = '𐐀'.repeat(200); // Deseret capital — \p{L}, and outside the BMP
    expect([...toSlug(astral)]).toHaveLength(120);
    expect(toSlug(astral)).toBe(toSlug(astral).normalize('NFKC')); // no lone surrogate
  });

  it('is linear on a hostile paste — it runs per keystroke', () => {
    const hostile = 'a'.repeat(100_000) + '!'.repeat(100_000);
    const t0 = Date.now();
    toSlug(hostile);
    expect(Date.now() - t0).toBeLessThan(100);
  });
});

describe('nothing hand-rolls the slug character rule', () => {
  it('leaves it to lib/url-base.ts', () => {
    // A private `[^a-z0-9-]` is how the store half came to throw Hebrew away while the product
    // half kept it — and a private class that omits NFKC reopens the two-stores-one-name hole.
    const offenders = walk('src')
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => !f.endsWith(join('lib', 'url-base.ts')))
      // Anchored on `replace(` so prose describing the OLD rule (store-products.ts' header
      // explains why it changed) isn't read as a call site.
      .filter((f) => /replace\(\/\[\^a-z0-9[\\a-z]*-\]/i.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
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
