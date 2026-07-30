import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
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

/** Every .ts and .astro file under src/, so a new route is covered without editing this test. */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) srcFiles(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.astro')) out.push(full);
  }
  return out;
}

/**
 * The behaviour above proves the validator works. This proves it is actually REACHED.
 *
 * Validation that lives in a module every caller is trusted to remember is the shape that has
 * already failed here twice: the redirect rule was copy-pasted into four routes and missing from
 * a fifth (`/api/lang`, an open redirect), and image intake itself shipped unvalidated until
 * 2026-07-29. So the rule is enforced by grep, the same way tests/safe-redirect.test.ts enforces
 * its own — a new route that assigns an image field straight out of a request fails here.
 */
/**
 * One definition, shared by the guard and by the test that proves the guard fires. Two copies of
 * this regex would let the self-check pass while the real scan quietly matched nothing — the same
 * duplication trap the guard itself exists to catch.
 */
const IMAGE_FIELD = '(?:images?|imageUrl|bannerImage|profileImage|thumb(?:nail)?Url|photoUrl|logoUrl|avatarUrl)';
const REQUEST_SOURCE = '(?:form\\.get(?:All)?\\(|body\\.|body\\[|searchParams\\.get\\(|payload\\.|data\\.)';
/** `field: <something drawn from the request>` on one line. */
const UNSAFE_ASSIGNMENT = new RegExp(`\\b${IMAGE_FIELD}\\s*:\\s*[^,;]*${REQUEST_SOURCE}`);
/** A line is fine if it routes through the validator (directly or via parseImages). */
const isValidated = (line: string) => line.includes('sanitizeImageUrl') || line.includes('parseImages');

describe('no image URL reaches storage unvalidated', () => {
  it('assigns an image field from request data only through sanitizeImageUrl', () => {
    const root = path.join(process.cwd(), 'src');
    const offenders: string[] = [];

    // `field: <something drawn from the request>` on one line, with no sanitiser in sight.

    for (const file of srcFiles(root)) {
      if (file.endsWith(path.join('lib', 'image-url.ts'))) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*')) return;
        if (!UNSAFE_ASSIGNMENT.test(line) || isValidated(line)) return;
        offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${code}`);
      });
    }

    expect(offenders, `pass these through sanitizeImageUrl() from src/lib/image-url.ts:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('the guard actually fires — it is not a regex that matches nothing', () => {
    // The exact shape that shipped before 2026-07-29, and the shape api/store.ts uses today.

    for (const bad of [
      "      bannerImage: form.get('bannerImage') || undefined,",
      '      images: body.images,',
      "      profileImage: searchParams.get('img'),",
      '      imageUrl: data.imageUrl,',
    ]) {
      expect(UNSAFE_ASSIGNMENT.test(bad) && !isValidated(bad), bad).toBe(true);
    }

    // What api/store.ts actually writes today: matched by the shape, cleared by the validator.
    const good = "      bannerImage: sanitizeImageUrl(form.get('bannerImage')) || undefined,";
    expect(UNSAFE_ASSIGNMENT.test(good)).toBe(true);
    expect(isValidated(good)).toBe(true);
  });
});
