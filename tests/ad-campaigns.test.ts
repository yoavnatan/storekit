import { describe, expect, it } from 'vitest';
import { parseDuration, parseAudience } from '../src/lib/ad-campaigns.js';

describe('parseDuration', () => {
  it('accepts the whitelisted day counts', () => {
    expect(parseDuration(7)).toBe(7);
    expect(parseDuration(14)).toBe(14);
    expect(parseDuration(30)).toBe(30);
  });

  it('rejects anything off the whitelist as ongoing (undefined)', () => {
    expect(parseDuration(1)).toBeUndefined();
    expect(parseDuration(31)).toBeUndefined();
    expect(parseDuration('14')).toBeUndefined(); // string, not number
    expect(parseDuration(null)).toBeUndefined();
    expect(parseDuration(undefined)).toBeUndefined();
  });
});

describe('parseAudience', () => {
  it('keeps a valid gender + age_group segment', () => {
    expect(parseAudience({ gender: 'women', age: 'kids' })).toEqual({ gender: 'women', age: 'kids' });
    expect(parseAudience({ gender: 'men', age: 'all' })).toEqual({ gender: 'men', age: 'all' });
  });

  it('coerces an invalid gender or age to "all"', () => {
    expect(parseAudience({ gender: 'nonbinary', age: '99-100' })).toBeUndefined(); // both fall back to all → no targeting
    expect(parseAudience({ gender: 'xyz', age: 'infant' })).toEqual({ gender: 'all', age: 'infant' });
  });

  it('treats a fully-open (all/all) segment as no targeting', () => {
    expect(parseAudience({ gender: 'all', age: 'all' })).toBeUndefined();
    expect(parseAudience({})).toBeUndefined();
  });

  it('rejects non-object input', () => {
    expect(parseAudience(null)).toBeUndefined();
    expect(parseAudience('women')).toBeUndefined();
    expect(parseAudience(42)).toBeUndefined();
  });
});
