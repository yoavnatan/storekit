import { describe, it, expect } from 'vitest';
import { buildUrlSetXml, buildSitemapIndexXml, SITEMAP_MAX_URLS, xmlEscape, toSitemapDate, type SitemapEntry } from '../src/lib/sitemap.js';

describe('xmlEscape', () => {
  it('escapes the five XML-significant characters', () => {
    expect(xmlEscape(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
  it('leaves a plain URL untouched', () => {
    expect(xmlEscape('https://example.com/store/acme')).toBe('https://example.com/store/acme');
  });
});

describe('toSitemapDate', () => {
  it('reduces a full ISO timestamp to its date part', () => {
    expect(toSitemapDate('2026-07-20T11:22:33.000Z')).toBe('2026-07-20');
  });
  it('returns undefined for missing or malformed input', () => {
    expect(toSitemapDate(undefined)).toBeUndefined();
    expect(toSitemapDate(null)).toBeUndefined();
    expect(toSitemapDate('not-a-date')).toBeUndefined();
  });
});

describe('buildUrlSetXml', () => {
  it('emits a valid urlset with the xml declaration and namespace', () => {
    const xml = buildUrlSetXml([{ loc: 'https://example.com/' }]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://example.com/</loc>');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('includes optional tags only when provided', () => {
    const entries: SitemapEntry[] = [
      { loc: 'https://example.com/store/acme', lastmod: '2026-07-20', changefreq: 'daily', priority: '0.8' },
      { loc: 'https://example.com/store/acme/widget' },
    ];
    const xml = buildUrlSetXml(entries);
    // Full entry carries every optional tag.
    expect(xml).toContain('<lastmod>2026-07-20</lastmod>');
    expect(xml).toContain('<changefreq>daily</changefreq>');
    expect(xml).toContain('<priority>0.8</priority>');
    // Bare entry emits exactly one <loc> and no optional tags.
    expect((xml.match(/<url>/g) ?? []).length).toBe(2);
    expect((xml.match(/<changefreq>/g) ?? []).length).toBe(1);
  });

  it('escapes an ampersand in a loc (e.g. a slug edge case) so the XML stays well-formed', () => {
    const xml = buildUrlSetXml([{ loc: 'https://example.com/store/a&b' }]);
    expect(xml).toContain('<loc>https://example.com/store/a&amp;b</loc>');
    expect(xml).not.toContain('a&b<');
  });
});

describe('buildSitemapIndexXml', () => {
  // The platform's content sitemap is sharded because a sitemap FILE may hold no more than 50,000
  // URLs (sitemaps.org/protocol.html, checked 2026-08-09) and is rejected whole above that. This is
  // the document that names the shards.
  it('names every shard, with the build date, in one <sitemapindex>', () => {
    const xml = buildSitemapIndexXml(
      ['https://example.com/sitemap-content-1.xml', 'https://example.com/sitemap-content-2.xml'],
      '2026-08-09',
    );
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect((xml.match(/<sitemap>/g) ?? []).length).toBe(2);
    expect(xml).toContain('<loc>https://example.com/sitemap-content-2.xml</loc>');
    expect((xml.match(/<lastmod>2026-08-09<\/lastmod>/g) ?? []).length).toBe(2);
    expect(xml.trimEnd().endsWith('</sitemapindex>')).toBe(true);
  });

  it('drops lastmod rather than emitting an empty tag when the date is unknown', () => {
    const xml = buildSitemapIndexXml(['https://example.com/sitemap-content-1.xml'], undefined);
    expect(xml).not.toContain('<lastmod>');
  });

  it('leaves margin under the protocol ceiling', () => {
    // The count moves every time a seller adds a product, and the ceiling has nothing between
    // "fine" and "the whole file is refused" — the margin is what makes that a non-event.
    expect(SITEMAP_MAX_URLS).toBeLessThan(50_000);
  });
});
