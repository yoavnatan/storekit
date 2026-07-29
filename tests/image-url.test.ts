import { describe, expect, it } from 'vitest';
import { sanitizeImageUrl, sanitizeImageUrls } from '../src/lib/image-url.js';

describe('sanitizeImageUrl', () => {
  it('keeps a normal https image URL untouched', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg';
    expect(sanitizeImageUrl(url)).toBe(url);
  });

  it('keeps a site-relative path, without the resolving base leaking into it', () => {
    expect(sanitizeImageUrl('/uploads/a.png')).toBe('/uploads/a.png');
    expect(sanitizeImageUrl('/uploads/a.png?v=2')).toBe('/uploads/a.png?v=2');
  });

  // The whole point: the STORED value can no longer contain the character that
  // closes an HTML attribute, so a missed escape downstream can't become XSS.
  it('percent-encodes an attribute-breakout payload instead of storing it raw', () => {
    const out = sanitizeImageUrl('https://evil.example/a" onerror="alert(1)');
    expect(out).not.toBeNull();
    expect(out).not.toContain('"');
    expect(out).toContain('%22');
  });

  it('rejects every scheme that is not https', () => {
    expect(sanitizeImageUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeImageUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(sanitizeImageUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBeNull();
    expect(sanitizeImageUrl('blob:https://x.example/abc')).toBeNull();
    expect(sanitizeImageUrl('vbscript:msgbox(1)')).toBeNull();
    expect(sanitizeImageUrl('http://x.example/a.png')).toBeNull();
  });

  // Looks like a path, resolves to a remote host — must not slip through the
  // site-relative branch.
  it('rejects a protocol-relative URL', () => {
    expect(sanitizeImageUrl('//evil.example/x.png')).toBeNull();
  });

  it('rejects junk, empties and non-strings without throwing', () => {
    expect(sanitizeImageUrl('')).toBeNull();
    expect(sanitizeImageUrl('   ')).toBeNull();
    expect(sanitizeImageUrl('not a url')).toBeNull();
    expect(sanitizeImageUrl(null)).toBeNull();
    expect(sanitizeImageUrl(undefined)).toBeNull();
    expect(sanitizeImageUrl(42)).toBeNull();
    expect(sanitizeImageUrl({ toString: () => 'https://x.example/a.png' })).toBeNull();
  });

  it('rejects a URL past the length cap', () => {
    expect(sanitizeImageUrl(`https://x.example/${'a'.repeat(2100)}.png`)).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeImageUrl('  https://x.example/a.png  ')).toBe('https://x.example/a.png');
  });
});

describe('sanitizeImageUrls', () => {
  it('drops the invalid entries and keeps the order of the rest', () => {
    expect(sanitizeImageUrls([
      'https://x.example/1.png',
      'javascript:alert(1)',
      '',
      'https://x.example/2.png',
    ])).toEqual(['https://x.example/1.png', 'https://x.example/2.png']);
  });

  it('de-duplicates after normalization, not before', () => {
    expect(sanitizeImageUrls([
      'https://x.example/a.png',
      '  https://x.example/a.png  ',
    ])).toEqual(['https://x.example/a.png']);
  });

  it('returns an empty list rather than throwing on a list of junk', () => {
    expect(sanitizeImageUrls([null, undefined, 7, {}])).toEqual([]);
  });
});
