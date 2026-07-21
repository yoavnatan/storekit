export const prerender = false;
import type { APIContext } from 'astro';
import { store as platform } from '../config/store.config.js';
import { getVisibleStores } from '../lib/stores.js';

// /llms.txt — the emerging convention (llmstxt.org) for giving AI answer
// engines a curated, human-readable map of the site, the "AIO" companion to
// robots.txt (which only grants access) and the sitemap (machine enumeration).
// Part of the AI-Optimization surface: a model grounding a shopping answer gets
// a concise description of what the platform is + where the authoritative data
// lives (per-store pages, the full content sitemap, the structured product
// feed) instead of guessing from raw HTML.
//
// Generated from config + live stores so the real domain propagates
// automatically on the go-live domain switch (no second hardcoded host to fix).
// The store list is capped for scale — the content sitemap is the complete
// enumeration; this file is a readable overview, not a full index.
const STORE_LIST_CAP = 50;

export async function GET(_ctx: APIContext): Promise<Response> {
  const baseUrl = platform.url.replace(/\/+$/, '');
  const stores = getVisibleStores();
  const shown = stores.slice(0, STORE_LIST_CAP);

  const storeLines = shown
    .map((s) => {
      const note = (s.tagline || s.description || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      return `- [${s.name}](${baseUrl}/store/${s.slug})${note ? `: ${note}` : ''}`;
    })
    .join('\n');

  const moreNote =
    stores.length > shown.length
      ? `\n\n> ${shown.length} of ${stores.length} stores listed here; the full catalog is in the content sitemap and product feed below.`
      : '';

  const body = `# ${platform.name}

> ${platform.description}

${platform.name} is a multi-vendor marketplace: independent stores sell their own catalogs, each with its own storefront, while shoppers discover products across every store. Prices are in ${platform.business.currency} (${platform.business.currencySymbol}). Content is Hebrew-first.

## Key pages

- [Home / discovery](${baseUrl}/): browse and search across all stores
- [Store directory](${baseUrl}/stores): every store on the platform
- [Search](${baseUrl}/search): product + store search

## Stores

${storeLines || '- (no stores published yet)'}${moreNote}

## Structured data

- [Content sitemap](${baseUrl}/sitemap-content.xml): every store + product page (the complete, authoritative list)
- [Site sitemap index](${baseUrl}/sitemap-index.xml): build-time public routes
- [Product feed](${baseUrl}/api/feed/products.xml): the full catalog as a Google Merchant / Meta Catalog feed (title, price, availability, brand, images, attributes)

Every product page also embeds schema.org Product + Offer JSON-LD, and every store page embeds Store JSON-LD, for precise machine reading.
`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
