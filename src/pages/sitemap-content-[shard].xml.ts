export const prerender = false;
import type { APIContext } from 'astro';
import { serveSitemapShard, notFound } from '../lib/catalog-artifacts.js';
import { isPlatformHost } from '../lib/custom-domain.js';

// One shard of the platform's content sitemap. `/sitemap-content.xml` is the INDEX that names these
// (and it is what robots.txt lists); this is where the URLs actually live.
//
// **Why the split exists at all:** a sitemap file may hold no more than 50,000 URLs — verified
// against sitemaps.org/protocol.html, 2026-08-09 — and over that Google rejects the file WHOLE. A
// mall of a thousand sellers with dozens of products each passes that, so the failure mode without
// this is not a missing tail but a platform with no content sitemap and nothing saying so. Shards
// are cut at 45,000 (`SITEMAP_MAX_URLS`), written by the `sitemap-artifact` job, and served from
// storage like every other artifact — this route builds nothing.
//
// An out-of-range or oddly-spelled shard is a 404, not a 503: it is never coming. See
// `serveSitemapShard`.

export async function GET(ctx: APIContext): Promise<Response> {
  // **A seller's own domain has no shards, and must not be handed the platform's.** A path with a
  // dot passes the custom-domain rewrite through untouched (`resolveCustomDomainRewrite`), so
  // without this the platform's URLs would be served from shop.acme.co.il — a sitemap listing a
  // host other than the one serving it, which is invalid by the protocol and exactly the boundary
  // `robots.txt.ts` was rewritten to hold. That domain's sitemap is its own single
  // `/sitemap-content.xml`.
  //
  // **The test is the HOST, not whether a store answers to it** (2026-08-21, area audit). It used to
  // look the host up and refuse only a matched one, which left every other foreign host — a previous
  // domain still 301-ing, a DNS pointed here before its store connected, a preview hostname — being
  // served the platform's URLs under a name that is not the platform's. Asking `isPlatformHost`
  // alone is the same rule the index route and `robots.txt` now apply, states it in one sentence,
  // and drops a database lookup from a document a crawler fetches.
  const host = ctx.request.headers.get('host') ?? '';
  if (host && !isPlatformHost(host)) return notFound();
  return serveSitemapShard(ctx.params.shard, 'application/xml; charset=utf-8', ctx.request);
}
