export const prerender = false;
import type { APIContext } from 'astro';
import { serveCatalogArtifact, REVIEW_FEED_ARTIFACT } from '../../../lib/catalog-artifacts.js';

// The Google **product reviews** feed — the URL that goes into Merchant Center under
// Reviews → Product reviews → data sources, as a scheduled fetch.
//
// A different programme from `products.xml` beside it, and worth keeping straight because the names
// are nearly identical: that one is the CATALOG (what is for sale, at what price), this one is
// RATINGS (what buyers said), and Merchant Center takes them as two unrelated data sources. Neither
// substitutes for the other and a rating in the product feed is not a thing that exists.
//
// **Not connectable yet, and the reason is a real threshold rather than a missing key:** Google's
// Product Ratings programme needs 50 reviews across the account before it will accept the feed at
// all, and a full re-upload at least monthly to stay eligible (checked against
// support.google.com/merchants/answer/14620705, 2026-08-17). The scheduled fetch handles the second
// half by itself; the first is a milestone the platform reaches by selling. GO_LIVE §2.7.
//
// Unauthenticated, like the product feed and for the same reason: it is a document the platforms
// PULL, and every byte in it is already public on the product page it links to. What it must not
// contain is anything that is not — which is why `review-feed.ts` omits `transaction_id`.
//
// Built by the `review-feed-artifact` job, never by this request — the argument is in
// `products.xml.ts` and applies unchanged. A 503 means it has never been built in this database.

export async function GET(ctx: APIContext): Promise<Response> {
  return serveCatalogArtifact(REVIEW_FEED_ARTIFACT, 'application/xml; charset=utf-8', ctx.request);
}
