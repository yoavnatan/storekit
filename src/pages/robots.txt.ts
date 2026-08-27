export const prerender = false;
import type { APIContext } from 'astro';
import { store as platform } from '../config/store.config.js';
import { getStoreByCustomDomain, isStorePublished } from '../lib/stores.js';
import { isPlatformHost } from '../lib/custom-domain.js';
import { stripTrailingSlashes } from '../lib/url-base.js';
import { siteIsHiddenFromSearch } from '../lib/site-mode.js';

// robots.txt — SSR, because it is HOST-DEPENDENT and used not to be.
//
// This was a static `public/robots.txt`, and a static file answers every hostname with the same
// bytes. That is wrong the moment a seller's own domain serves their store: `shop.mybrand.co.il`
// was handing crawlers a file whose only two `Sitemap:` lines point at `dezabin.co.il`. A sitemap
// reference across hosts is ignored by every engine (neither host has proven it owns the other), so
// the seller's domain declared NO sitemap at all — while `sitemap-content.xml` was already serving
// that domain's own correct sitemap, with nothing anywhere pointing to it. The one file whose whole
// job is to tell a crawler where to look was the one file that could not tell it apart.
//
// Deleting the public file is what makes this route reachable: a file in `public/` outranks a route.

/** The crawl rules, identical on every host — they describe paths, and every platform path exists on
 *  a custom host too (the middleware passes reserved routes through untouched, so `/checkout` and
 *  `/admin` really do resolve there). `feedAllowed` is the one difference: Merchant Center and the
 *  Meta catalog fetch the feed from the PLATFORM domain and only from there (custom-domain.ts →
 *  AD_LANDING_PARAM), so re-inviting a crawler into `/api/feed/` on a seller's domain would publish
 *  the whole mall's catalogue under their hostname for no gain. */
function rules(feedAllowed: boolean): string {
  const feed = feedAllowed
    ? '# Block the API surface, but the product feed under it MUST stay fetchable —\n'
      + '# Google Merchant Center / Meta Catalog crawl it and honour robots.txt. Google\n'
      + '# resolves the longest matching rule, so this Allow wins for the feed path only.\n'
      + 'Allow: /api/feed/\n'
    : '';
  return `Allow: /\nDisallow: /admin\nDisallow: /checkout\n${feed}Disallow: /api\n`;
}

/** The AI answer engines we explicitly welcome (AIO): our stores and products may be surfaced and
 *  cited in AI shopping answers. A named group REPLACES the '*' rules for that bot, so the same
 *  protections have to be repeated inside it. Google-Extended / Applebot-Extended are grounding
 *  opt-ins — listing them Allow is a deliberate "yes, use our catalog" (see /llms.txt). */
export const AI_AGENTS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Perplexity-User',
  'ClaudeBot', 'anthropic-ai', 'Claude-Web', 'Google-Extended', 'Applebot-Extended',
  'Amazonbot', 'Meta-ExternalAgent', 'CCBot',
];

function body(sitemaps: readonly string[], feedAllowed: boolean): string {
  const block = rules(feedAllowed);
  const groups = [
    `User-agent: *\n${block}`,
    `${AI_AGENTS.map((a) => `User-agent: ${a}`).join('\n')}\n${block}`,
  ];
  // No sitemaps → no trailing block at all, rather than a stray blank line where the directives
  // were. A host with no sitemap of its own is the normal case now, not an edge (see GET).
  if (sitemaps.length) groups.push(sitemaps.map((s) => `Sitemap: ${s}`).join('\n') + '\n');
  return groups.join('\n');
}

/**
 * The whole site closed to crawling — `SITE_NOINDEX=1` (`lib/site-mode.ts`).
 *
 * Deliberately host-independent: it answers before the custom-domain branch below, so a seller's
 * domain is covered by the same decision rather than staying open through a different code path.
 *
 * **No `Sitemap:` line, on purpose.** A sitemap is an invitation to crawl the URLs in it, and one
 * published next to `Disallow: /` is a document that argues with itself; engines have been observed
 * to take the invitation. If nothing may be crawled, nothing is offered.
 *
 * And this file is only half the switch — `Seo.astro` puts `noindex` on every page for the same
 * reason. `Disallow` stops a crawl; `noindex` is what removes a page that was ALREADY taken, and a
 * page that is disallowed can never be re-read to discover it is now noindex. Both, always.
 */
/**
 * The preview fetchers, exempted on purpose — they are not search crawlers.
 *
 * LinkedIn, Slack, WhatsApp and the rest read a URL once, when a human pastes it, to render the
 * card for that single post. Nothing of it enters an index. Under a blanket `Disallow: /`
 * LinkedIn does not merely skip the preview, it refuses the address outright and tells the owner
 * to enter a valid URL — which is what happened the first time the demo was put in a CV. Closing
 * the site to search must not also make it unshareable.
 */
const PREVIEW_AGENTS = [
  'LinkedInBot',
  'Twitterbot',
  'facebookexternalhit',
  'Slackbot-LinkExpanding',
  'WhatsApp',
  'TelegramBot',
] as const;

function closedToCrawlers(): string {
  const previews = PREVIEW_AGENTS.map((a) => `User-agent: ${a}\nAllow: /\n`).join('\n');
  return `${previews}\nUser-agent: *\nDisallow: /\n`;
}

export async function GET(ctx: APIContext): Promise<Response> {
  if (siteIsHiddenFromSearch()) return txt(closedToCrawlers());

  const host = (ctx.request.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '').trim();

  // A seller's own verified domain: its sitemap is the one `sitemap-content.xml` builds for THAT
  // host, and it is the only sitemap that may be named here. The platform's two are not this
  // domain's to declare, and the static file was declaring them anyway.
  if (host && !isPlatformHost(host)) {
    // **This lookup may not be allowed to fail the response, and that is not ordinary defensiveness.**
    // A 5xx on robots.txt is read by Google as "disallow everything" and pauses crawling of the
    // whole site for hours — so an unreachable database would turn a partial outage into an SEO
    // outage that outlives it, on the one file that has no content worth failing over. Same reason
    // `/api/health` is exempted from this middleware: what reports the outage must survive it.
    const store = await getStoreByCustomDomain(host).catch(() => null);
    // **No `Sitemap:` line unless this host has one of its own** (2026-08-21, area audit of the SEO
    // surfaces). The crawl RULES still fall through for an unrecognised host — an old domain still
    // 301-ing, DNS pointed here before the store connected, or a database that could not answer —
    // because they describe paths and are never wrong to state. The sitemap references are the
    // opposite: naming `https://dezabin.co.il/sitemap-…` from a host that is not dezabin.co.il is
    // the exact cross-host reference this route was written to stop, restated by the route itself in
    // its own fall-through. An engine ignores it, Search Console reports it against the SELLER's
    // property, and the honest answer is that this host declares no sitemap.
    // `isStorePublished` for the same reason as the paragraph above: a store that has not gone live
    // yet answers 404 on every one of its pages and its sitemap is empty by construction
    // (`isStoreDiscoverable`), so naming one would point a crawler at a document that describes
    // nothing. It comes back the moment the shop is published, with no cache to wait out beyond the
    // five minutes below.
    const named = store && isStorePublished(store) ? [`https://${store.customDomain!.hostname}/sitemap-content.xml`] : [];
    return txt(body(named, false));
  }

  const base = stripTrailingSlashes(platform.url);
  // Two sitemaps, and Google merges multiple `Sitemap:` directives: the static one for build-time
  // public routes, and the dynamic one enumerating every store + product page (SSR — absent from
  // the static sitemap).
  return txt(body([`${base}/sitemap-index.xml`, `${base}/sitemap-content.xml`], true));
}

function txt(content: string): Response {
  return new Response(content, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Short, because the answer changes the day a seller's domain verifies.
      'Cache-Control': 'public, max-age=300',
    },
  });
}
