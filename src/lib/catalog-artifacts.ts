/**
 * The catalogue-wide documents: what they are called, how often they are rebuilt, and how a route
 * hands one over.
 *
 * This is the only file that knows both halves — `artifacts.ts` stores bytes it does not
 * understand, `feed-document.ts` / `sitemap-document.ts` produce content they do not store — and
 * it is the only place that knows a sitemap SHARD's name and URL are the same fact said twice.
 */
import {
  readArtifactMeta,
  writeArtifact,
  artifactResponse,
  artifactUnavailable,
  pruneArtifacts,
  ArtifactWriter,
} from './artifacts.js';
import { feedDocumentChunks } from './feed-document.js';
import { reviewFeedChunks } from './review-feed-document.js';
import { platformSitemapEntries } from './sitemap-document.js';
import {
  buildSitemapIndexXml,
  urlEntryXml,
  SITEMAP_MAX_URLS,
  URLSET_XML_HEADER,
  URLSET_XML_FOOTER,
  toSitemapDate,
} from './sitemap.js';
import { newBuildStats } from './catalog-build.js';
import { singleFlight } from './single-flight.js';
import { logError } from './error-log.js';
import { store as platform } from '../config/store.config.js';
import { stripTrailingSlashes } from './url-base.js';

export const FEED_ARTIFACT = 'feed:products.xml';
/** The Google **product reviews** feed (`review-feed-document.ts`) — a different programme from the
 *  product feed above and a different document, fetched on its own schedule by Merchant Center. */
export const REVIEW_FEED_ARTIFACT = 'feed:product-reviews.xml';
/** The sitemap INDEX — what `/sitemap-content.xml` serves and robots.txt names. */
export const SITEMAP_ARTIFACT = 'sitemap:content.xml';
/** Every shard's name starts with this, which is how a rebuild prunes the ones it did not write. */
export const SITEMAP_SHARD_PREFIX = 'sitemap:content:';

export function sitemapShardArtifact(shard: number): string {
  return `${SITEMAP_SHARD_PREFIX}${shard}`;
}

/** The public URL of a shard. Same fact as its artifact name, and stated once so the index cannot
 *  advertise a file the route does not answer to. */
export function sitemapShardUrl(baseUrl: string, shard: number): string {
  return `${baseUrl}/sitemap-content-${shard}.xml`;
}

/**
 * How often each is rebuilt — **and the `max-age` the routes publish, deliberately the same
 * number.**
 *
 * The freshness a caller actually sees is the artifact's age plus whatever a CDN is still holding,
 * so those two are one budget and it is worth naming what it is spent on. Before this change the
 * document was built per request (age 0) and cached for an hour: worst case one hour stale. Half an
 * hour on each side keeps that same hour, which matters because the feed's staleness is not
 * cosmetic — a price or availability that disagrees with the landing page is the one feed mismatch
 * that is a Merchant Center *account* risk (memory `project_merchant_brand_mismatch_verified`), and
 * the account is shared by every seller on the platform.
 *
 * It is also as fast as is worth rebuilding: Merchant Center fetches a scheduled feed daily and
 * Meta hourly, so a shorter interval would mostly rewrite tens of megabytes that nobody pulls.
 *
 * Deliberately NOT a "rebuild only if something changed" fingerprint. It was considered: a cheap
 * `max(updated_at) + count` per table would skip the write when the catalogue is untouched. At the
 * scale this whole change is for — a thousand sellers — some product changes in almost every
 * window, so it would rarely fire; and a fingerprint that is wrong in the other direction pins a
 * stale feed in place silently, which is exactly the failure class this project keeps paying for.
 */
export const CATALOG_ARTIFACT_INTERVAL_SEC = 30 * 60;

/**
 * Rebuild one document and publish it. Returns the line its job records.
 *
 * *Idempotent*, which is what `jobs/registry.ts` requires of everything it lists: it derives the
 * document from current state and swaps a pointer, so a second run writes a second generation with
 * the same content and the reader cannot tell. Nothing accumulates — a publish keeps two
 * generations, and the sitemap prunes shards it did not write.
 */
export async function rebuildCatalogArtifact(name: string): Promise<string> {
  if (name === FEED_ARTIFACT) return rebuildFeedArtifact();
  if (name === REVIEW_FEED_ARTIFACT) return rebuildReviewFeedArtifact();
  if (name === SITEMAP_ARTIFACT) return rebuildSitemapArtifacts();
  throw new Error(`unknown catalog artifact "${name}"`);
}

async function rebuildFeedArtifact(): Promise<string> {
  const stats = newBuildStats();
  const meta = await writeArtifact(FEED_ARTIFACT, feedDocumentChunks(stats), () => `${stats.stores} stores · ${stats.items} items`);
  return `${meta.detail} · ${meta.partCount} parts · ${meta.byteSize} bytes`;
}

async function rebuildReviewFeedArtifact(): Promise<string> {
  const stats = newBuildStats();
  const meta = await writeArtifact(REVIEW_FEED_ARTIFACT, reviewFeedChunks(stats), () => `${stats.stores} stores · ${stats.items} reviews`);
  return `${meta.detail} · ${meta.partCount} parts · ${meta.byteSize} bytes`;
}

/**
 * Rebuild the sitemap: as many shard files as the catalogue needs, then the index that names them.
 *
 * **Why an index at all, and why always.** One sitemap file may hold 45,000 URLs
 * (`SITEMAP_MAX_URLS`, and the spec's real ceiling is 50,000) — past that Google rejects the file
 * WHOLE, so the symptom is not a missing tail but a platform with no content sitemap, silently. A
 * mall of a thousand sellers with dozens of products each is exactly that size. The index is
 * written even when there is one shard, on purpose: a document shape that changes by itself the
 * first time a threshold is crossed is a shape nobody has ever seen work, arriving unannounced at
 * the worst moment.
 *
 * **The shards are written before the index, and the index is the last write.** Until it lands, the
 * previous index is still live and still names the previous shards — which are still there, because
 * a shard is only pruned after a successful index. So a crash halfway leaves the old sitemap whole.
 *
 * `maxUrlsPerShard` is a parameter only so the boundary can be tested without 45,000 rows; nothing
 * in the application passes it.
 */
export async function rebuildSitemapArtifacts(maxUrlsPerShard: number = SITEMAP_MAX_URLS): Promise<string> {
  const baseUrl = stripTrailingSlashes(platform.url);
  const stats = newBuildStats();
  const shardNames: string[] = [];
  let writer: ArtifactWriter | null = null;
  let inShard = 0;

  const closeShard = async (): Promise<void> => {
    if (!writer) return;
    await writer.write(URLSET_XML_FOOTER);
    await writer.close(`${inShard} urls`);
    writer = null;
  };

  for await (const entry of platformSitemapEntries(stats)) {
    if (!writer || inShard >= maxUrlsPerShard) {
      await closeShard();
      shardNames.push(sitemapShardArtifact(shardNames.length + 1));
      writer = await ArtifactWriter.open(shardNames[shardNames.length - 1]!);
      await writer.write(URLSET_XML_HEADER);
      inShard = 0;
    }
    // The newline BEFORE every entry but the first is what `entries.join('\n')` used to do.
    await writer.write(`${inShard ? '\n' : ''}${urlEntryXml(entry)}`);
    inShard++;
  }
  await closeShard();

  // An empty catalogue still gets one (empty) shard, so the index never points at nothing and the
  // URL never 404s. An index listing zero sitemaps is not a valid document.
  if (!shardNames.length) {
    shardNames.push(sitemapShardArtifact(1));
    const empty = await ArtifactWriter.open(shardNames[0]!);
    await empty.write(URLSET_XML_HEADER);
    await empty.write(URLSET_XML_FOOTER);
    await empty.close('0 urls');
  }

  const lastmod = toSitemapDate(new Date().toISOString());
  const locs = shardNames.map((_, i) => sitemapShardUrl(baseUrl, i + 1));
  const index = buildSitemapIndexXml(locs, lastmod);
  await writeArtifact(SITEMAP_ARTIFACT, (async function* () { yield index; })(), () => `${shardNames.length} shards · ${stats.items} urls`);

  // Only now: a shard the previous build wrote and this one did not is a file serving a slice of a
  // catalogue that no longer exists, reachable by anything that remembers the URL.
  const pruned = await pruneArtifacts(SITEMAP_SHARD_PREFIX, shardNames);
  return `${stats.stores} stores · ${stats.items} urls · ${shardNames.length} shards${pruned ? ` · pruned ${pruned}` : ''}`;
}

/**
 * Serve `name`, or say "not yet" and start building it.
 *
 * **The cold path is a 503 and a build nobody waits for.** A process whose database has never held
 * this document — a first deploy, a fresh environment, `npm run dev` where the scheduler is off by
 * design — would otherwise serve nothing until the next tick. It must not build the document *for*
 * the caller: that is the request-time build this whole change removes, and it is a public
 * unauthenticated URL, so it would hand anyone a way to start one. So the request returns
 * immediately and the build runs behind it, under `singleFlight`, which caps a flood of cold
 * callers at one build. Once the artifact exists this branch is never taken again.
 */
export async function serveCatalogArtifact(name: string, contentType: string, request: Request): Promise<Response> {
  const meta = await readArtifactMeta(name);
  if (!meta) {
    startColdBuild(name);
    return artifactUnavailable();
  }
  return artifactResponse(meta, contentType, request, CATALOG_ARTIFACT_INTERVAL_SEC);
}

export function notFound(): Response {
  return new Response('not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/**
 * Serve one sitemap shard, named by the raw path segment.
 *
 * **The RAW segment, not a number**, because `Number()` accepts far more than a shard number is:
 * `01`, `1.0`, `+1`, ` 1` and `1e0` all read as 1, so the same file would answer at five URLs. A
 * sitemap is not indexed content, so that is not a duplicate-content problem — it is a document
 * that exists at addresses the index never named, which is the sort of thing that later turns up in
 * a crawl report with nobody able to say where it came from. One canonical spelling, everything
 * else 404.
 *
 * **A shard that does not exist is a 404 and not a 503**, and the difference matters: 503 means
 * "ask again", which is right for a document that is coming, and wrong for `sitemap-content-9.xml`
 * on a platform that has three shards — that file is never coming, and telling a crawler to retry
 * it forever wastes its budget. The one exception is a database that has built nothing at all,
 * where shard 1 genuinely is on its way.
 */
export async function serveSitemapShard(rawShard: string | undefined, contentType: string, request: Request): Promise<Response> {
  if (!rawShard || !/^[1-9]\d*$/.test(rawShard)) return notFound();
  const meta = await readArtifactMeta(sitemapShardArtifact(Number(rawShard)));
  if (meta) return artifactResponse(meta, contentType, request, CATALOG_ARTIFACT_INTERVAL_SEC);

  if (rawShard === '1' && !(await readArtifactMeta(SITEMAP_ARTIFACT))) {
    startColdBuild(SITEMAP_ARTIFACT);
    return artifactUnavailable();
  }
  return notFound();
}

function startColdBuild(name: string): void {
  void singleFlight(`artifact:${name}`, () => rebuildCatalogArtifact(name)).catch((err: unknown) => {
    // Fire-and-forget: the caller already has its 503 and the scheduler will try again on its own
    // interval. It is logged rather than swallowed because a build that fails every time is a feed
    // that never appears, and nothing else would ever say so.
    void logError({
      source: 'server',
      route: `artifact:${name}`,
      message: `cold build of "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      resolutionHint: 'The scheduled job retries at its next interval; a repeat means the build itself is broken.',
    });
  });
}
