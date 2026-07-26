// Pure, isomorphic sitemap XML builder. Takes already-gathered URL entries and
// serialises them into a standards-compliant <urlset> document — no data access
// here, so it's trivially testable (see tests/sitemap.test.ts) and reusable by
// any route that needs to emit a sitemap. The dynamic content sitemap
// (src/pages/sitemap-content.xml.ts) is the current caller: store + product
// pages are SSR (`prerender = false`), so @astrojs/sitemap never sees them at
// build time and they must be enumerated from live data at request time instead.

export interface SitemapEntry {
  /** Absolute URL, e.g. "https://example.com/acme". */
  loc: string;
  /** W3C date (YYYY-MM-DD) or full ISO datetime; omitted if unknown. */
  lastmod?: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  /** 0.0–1.0 as a string, e.g. "0.8". */
  priority?: string;
}

/** Escapes the five XML-significant characters. `loc` values are already URL-safe
 *  slugs today, but a store/product name never reaches <loc>; this guards the
 *  contract regardless of what a future caller passes in. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Normalises a stored ISO timestamp to a sitemap-valid `<lastmod>` date part
 *  (YYYY-MM-DD). Returns undefined for anything that doesn't look like a date,
 *  so an invalid value simply drops the optional tag rather than emitting junk. */
export function toSitemapDate(iso: string | undefined | null): string | undefined {
  if (!iso) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : undefined;
}

/** Serialises entries into a complete sitemap <urlset> document. */
export function buildUrlSetXml(entries: SitemapEntry[]): string {
  const urls = entries
    .map((e) => {
      const lines = [`    <loc>${xmlEscape(e.loc)}</loc>`];
      if (e.lastmod) lines.push(`    <lastmod>${xmlEscape(e.lastmod)}</lastmod>`);
      if (e.changefreq) lines.push(`    <changefreq>${e.changefreq}</changefreq>`);
      if (e.priority) lines.push(`    <priority>${e.priority}</priority>`);
      return `  <url>\n${lines.join('\n')}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
