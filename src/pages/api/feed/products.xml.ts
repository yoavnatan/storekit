export const prerender = false;
import type { APIContext } from 'astro';
import { serveCatalogArtifact, FEED_ARTIFACT } from '../../../lib/catalog-artifacts.js';

// Platform-wide product feed (CURRENT_TASK.md item 14) — the single bulk export
// Google Merchant Center / Meta Catalog fetch on a schedule to power the
// baseline (and boost) catalog campaigns. Each product is emitted with its own
// derived attributes (gender/age_group/brand/condition/custom_labels — see
// product-feed.ts), so per-product audience targeting is REAL at the data level
// the moment this URL is connected in Merchant Center; no seller opt-in, no
// per-product manual setup.
//
// Only visible (non-blocked, non-demo) stores/products are exported — a blocked
// listing must never keep running in the shared platform's ads, and the
// platform's own showcase stores (lib/demo-stores.ts) are fabricated catalog:
// submitting those to Merchant Center is a policy violation against the whole
// account, not just an aesthetic problem. Unauthenticated on purpose: a data
// feed is a public URL the platforms pull, and it exposes only already-public
// catalog data. That rule is enforced in `feed-document.ts`, which is where the
// document is now assembled.
//
// **This route no longer builds anything, and that is the whole point of it
// (2026-08-09).** It used to walk the entire platform catalogue into one string
// per request — 6.1 seconds at 45 stores, measured here, on the single event
// loop every shopper shares, and a several-hundred-megabyte allocation at a
// thousand sellers. `single-flight` and a 1h `Cache-Control` restrained that
// without moving it: concurrent pulls shared one build and serial floods went to
// the CDN, but the build itself still happened in the process serving buyers.
// The note this file carried since the JSON era said it becomes "a
// cached/generated artifact" once the data lives in Postgres. It does now: the
// `feed-artifact` job in `jobs/registry.ts` builds it in chunks, `artifacts.ts`
// stores it, and this route streams what is stored. GO_LIVE §7.
//
// A 503 here means the document has never been built in this database — see
// `serveCatalogArtifact`, which answers that and starts the build.

export async function GET(ctx: APIContext): Promise<Response> {
  return serveCatalogArtifact(FEED_ARTIFACT, 'application/xml; charset=utf-8', ctx.request);
}
