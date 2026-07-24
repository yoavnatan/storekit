import { describe, it, expect } from 'vitest';
import {
  parseObjective,
  parsePlatform,
  parseBrandDuration,
  sanitizeDestination,
  sanitizeImageUrl,
  defaultDestination,
  parseCreateInput,
} from '../src/lib/brand-campaigns.js';

describe('brand-campaigns input coercion', () => {
  it('objective/platform default safely', () => {
    expect(parseObjective('sellers')).toBe('sellers');
    expect(parseObjective('buyers')).toBe('buyers');
    expect(parseObjective('garbage')).toBe('buyers');
    expect(parsePlatform('meta')).toBe('meta');
    expect(parsePlatform('anything')).toBe('google');
  });

  it('duration accepts only the whitelist', () => {
    expect(parseBrandDuration(7)).toBe(7);
    expect(parseBrandDuration('30')).toBe(30);
    expect(parseBrandDuration(5)).toBeUndefined();
    expect(parseBrandDuration('ongoing')).toBeUndefined();
  });

  it('defaultDestination maps objective → landing path', () => {
    expect(defaultDestination('buyers')).toBe('/');
    expect(defaultDestination('sellers')).toBe('/seller/register');
  });

  it('sanitizeDestination blocks unsafe schemes, allows path + http(s)', () => {
    expect(sanitizeDestination('/stores', 'buyers')).toBe('/stores');
    expect(sanitizeDestination('https://dezabin.co.il/x', 'buyers')).toBe('https://dezabin.co.il/x');
    // Unsafe / non-URL → falls back to the objective default, never passes through.
    expect(sanitizeDestination('javascript:alert(1)', 'buyers')).toBe('/');
    expect(sanitizeDestination('javascript:alert(1)', 'sellers')).toBe('/seller/register');
    expect(sanitizeDestination('  ', 'sellers')).toBe('/seller/register');
    expect(sanitizeDestination(42, 'buyers')).toBe('/');
  });

  it('sanitizeImageUrl accepts only https', () => {
    expect(sanitizeImageUrl('https://res.cloudinary.com/x.png')).toBe('https://res.cloudinary.com/x.png');
    expect(sanitizeImageUrl('http://insecure/x.png')).toBeUndefined();
    expect(sanitizeImageUrl('javascript:x')).toBeUndefined();
    expect(sanitizeImageUrl(123)).toBeUndefined();
  });

  it('parseCreateInput rejects missing headline/body/budget, coerces the rest', () => {
    expect(parseCreateInput(null)).toBeNull();
    expect(parseCreateInput({ headline: 'x', body: '', monthlyBudget: 5 })).toBeNull();
    expect(parseCreateInput({ headline: 'x', body: 'y', monthlyBudget: -1 })).toBeNull();

    const ok = parseCreateInput({
      objective: 'sellers',
      headline: '  Open a store  ',
      body: 'Join Dezabin',
      monthlyBudget: '500',
      platform: 'meta',
      durationDays: '14',
      destinationUrl: 'javascript:alert(1)', // must be scrubbed to the default
      imageUrl: 'http://insecure',           // must be dropped (not https)
    });
    expect(ok).not.toBeNull();
    expect(ok!.headline).toBe('Open a store');
    expect(ok!.monthlyBudget).toBe(500);
    expect(ok!.platform).toBe('meta');
    expect(ok!.durationDays).toBe(14);
    expect(ok!.destinationUrl).toBe('/seller/register');
    expect(ok!.imageUrl).toBeUndefined();
  });
});
