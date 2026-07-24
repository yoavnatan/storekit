import { describe, expect, it } from 'vitest';
import { isPlaceholderHost, indexNowEnabled, buildIndexNowPayload } from '../src/lib/indexnow.js';

describe('indexnow guards', () => {
  it('treats example.* and unparseable urls as placeholder hosts', () => {
    expect(isPlaceholderHost('https://example.com')).toBe(true);
    expect(isPlaceholderHost('https://shop.example.com')).toBe(true);
    expect(isPlaceholderHost('not-a-url')).toBe(true);
    expect(isPlaceholderHost('https://dezabin.co.il')).toBe(false);
  });

  it('is enabled only with a key AND a real domain', () => {
    expect(indexNowEnabled({ key: '', siteUrl: 'https://dezabin.co.il' })).toBe(false);
    expect(indexNowEnabled({ key: 'abc', siteUrl: 'https://example.com' })).toBe(false);
    expect(indexNowEnabled({ key: '  ', siteUrl: 'https://dezabin.co.il' })).toBe(false);
    expect(indexNowEnabled({ key: 'abc', siteUrl: 'https://dezabin.co.il' })).toBe(true);
  });
});

describe('buildIndexNowPayload', () => {
  const cfg = { key: 'k123', siteUrl: 'https://dezabin.co.il' };

  it('absolutizes relative paths, sets host + keyLocation', () => {
    const p = buildIndexNowPayload(['/store/a/prod', '/store/a'], cfg);
    expect(p.host).toBe('dezabin.co.il');
    expect(p.key).toBe('k123');
    expect(p.keyLocation).toBe('https://dezabin.co.il/k123.txt');
    expect(p.urlList).toEqual(['https://dezabin.co.il/store/a/prod', 'https://dezabin.co.il/store/a']);
  });

  it('keeps absolute urls and dedupes', () => {
    const p = buildIndexNowPayload(['https://dezabin.co.il/x', '/x'], cfg);
    expect(p.urlList).toEqual(['https://dezabin.co.il/x']);
  });

  it('tolerates a trailing slash on the site url', () => {
    const p = buildIndexNowPayload(['/y'], { key: 'k', siteUrl: 'https://dezabin.co.il/' });
    expect(p.urlList).toEqual(['https://dezabin.co.il/y']);
    expect(p.keyLocation).toBe('https://dezabin.co.il/k.txt');
  });
});
