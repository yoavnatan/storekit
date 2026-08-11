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

/** Re-exported so existing callers keep working, but the RULE now lives in `xml-text.ts`.
 *
 *  This used to be a private copy that escaped the five significant characters and stopped there,
 *  while `product-feed.ts`'s same-named function ALSO stripped the characters XML forbids outright.
 *  Two escapers, one silently weaker, and the weaker one guarding the document Google parses: an
 *  illegal character does not spoil one `<url>`, it makes the whole sitemap unparseable. Unreachable
 *  today because `loc` carries only slugs (`toSlug` already drops those characters) — but this
 *  function's own comment promised to hold "regardless of what a future caller passes in", and it
 *  did not. Now it does. */
export { xmlEscape } from './xml-text.js';
import { xmlEscape } from './xml-text.js';

/** Normalises a stored ISO timestamp to a sitemap-valid `<lastmod>` date part
 *  (YYYY-MM-DD). Returns undefined for anything that doesn't look like a date,
 *  so an invalid value simply drops the optional tag rather than emitting junk. */
export function toSitemapDate(iso: string | undefined | null): string | undefined {
  if (!iso) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : undefined;
}

/**
 * The document in its three pieces. Same reason as `product-feed.ts`'s split: the platform's copy
 * of this sitemap is no longer built in one go — a job streams it into storage a part at a time
 * (`sitemap-document.ts`) — so the frame and the entries have to be obtainable separately, and
 * exporting them keeps ONE definition of what a `<urlset>` looks like. `buildUrlSetXml` is composed
 * of exactly these, and still serves the per-store custom-domain sitemap, which is one shelf and
 * needs no streaming.
 */
export const URLSET_XML_HEADER = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

/** The leading newline closes the last entry's line — entries are joined by one, so the separator
 *  belongs to whatever comes after them. */
export const URLSET_XML_FOOTER = `\n</urlset>\n`;

/** One `<url>` block, the unit the streamed build emits. */
export function urlEntryXml(e: SitemapEntry): string {
  const lines = [`    <loc>${xmlEscape(e.loc)}</loc>`];
  if (e.lastmod) lines.push(`    <lastmod>${xmlEscape(e.lastmod)}</lastmod>`);
  if (e.changefreq) lines.push(`    <changefreq>${e.changefreq}</changefreq>`);
  if (e.priority) lines.push(`    <priority>${e.priority}</priority>`);
  return `  <url>\n${lines.join('\n')}\n  </url>`;
}

/** Serialises entries into a complete sitemap <urlset> document. */
export function buildUrlSetXml(entries: SitemapEntry[]): string {
  return `${URLSET_XML_HEADER}${entries.map(urlEntryXml).join('\n')}${URLSET_XML_FOOTER}`;
}

/**
 * **A sitemap file may hold no more than 50,000 URLs** (and no more than 50MB uncompressed) —
 * verified against sitemaps.org/protocol.html on 2026-08-09, which states it in those words. Over
 * either limit the file is rejected WHOLE, so the failure is not "the tail is missing", it is "this
 * platform has no content sitemap". A sitemap index may itself list up to 50,000 files, so the two
 * levels together are far more room than this platform can use.
 *
 * 45,000 and not 50,000: the ceiling is a cliff with nothing between "fine" and "the whole document
 * is refused", and the count moves every time a seller adds a product. The margin is what makes a
 * build that lands slightly differently than the last one a non-event.
 */
export const SITEMAP_MAX_URLS = 45_000;

/** Serialises a <sitemapindex> — the document that names the shards. `lastmod` is the build date,
 *  which is the honest answer for every shard: they are written by one pass. */
export function buildSitemapIndexXml(locs: readonly string[], lastmod: string | undefined): string {
  const items = locs
    .map((loc) => {
      const lines = [`    <loc>${xmlEscape(loc)}</loc>`];
      if (lastmod) lines.push(`    <lastmod>${xmlEscape(lastmod)}</lastmod>`);
      return `  <sitemap>\n${lines.join('\n')}\n  </sitemap>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</sitemapindex>\n`;
}
