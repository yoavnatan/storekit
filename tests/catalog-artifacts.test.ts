/**
 * The pre-built feed and sitemap, against a real Postgres.
 *
 * **The one property everything here is protecting.** Both documents used to be assembled inside
 * the request that asked for them — the whole platform catalogue, in memory, on the single event
 * loop every shopper shares (6.1 seconds at 45 stores, measured in this repo). They are built by a
 * job now and streamed from storage (GO_LIVE §7, migration 0022). A change like that is only safe
 * if the bytes are the same, so the two central tests assert exactly that: the streamed document
 * equals what the single-shot serialiser produces for the same catalogue, byte for byte.
 *
 * That comparison is only worth something because the expectation is composed from the SAME
 * per-store functions the build uses (`storeFeedItems`, `platformStoreEntries`) — a hand-written
 * expected document would be a second definition of what a feed row contains, and would stop
 * asserting anything the day one of them changed. What the test genuinely owns is the part the
 * build added: the ORDER across batches, the separators between items, and the frame.
 *
 * **Which is why the fixture is padded to more than one batch.** The committed dataset is three
 * stores and `STORE_BATCH` is 20, so a single window would cover the whole catalogue and the
 * batching loop — the actual new code — would never run twice. The extra stores below exist to make
 * the second window real.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { getIndexableStores } from '../src/lib/stores.js';
import { createProduct, getVisibleProductsByStoreIds, getVisibleProductRefsByStoreIds } from '../src/lib/store-products.js';
import { getCategoriesByStoreIds } from '../src/lib/store-categories.js';
import { getPurchasedCountsByStoreSlugs } from '../src/lib/orders.js';
import { toMerchantXml } from '../src/lib/product-feed.js';
import { buildUrlSetXml } from '../src/lib/sitemap.js';
import { feedChannelMeta, feedDocumentChunks, storeFeedItems } from '../src/lib/feed-document.js';
import { platformStoreEntries } from '../src/lib/sitemap-document.js';
import { newBuildStats, STORE_BATCH } from '../src/lib/catalog-build.js';
import { readArtifactMeta, artifactStream, writeArtifact } from '../src/lib/artifacts.js';
import {
  CATALOG_ARTIFACT_INTERVAL_SEC,
  FEED_ARTIFACT,
  SITEMAP_ARTIFACT,
  rebuildCatalogArtifact,
  rebuildSitemapArtifacts,
  serveCatalogArtifact,
  serveSitemapShard,
  sitemapShardArtifact,
  sitemapShardUrl,
} from '../src/lib/catalog-artifacts.js';
import { stripTrailingSlashes } from '../src/lib/url-base.js';
import { store as platform } from '../src/config/store.config.js';

const DANA = '11111111-1111-4111-8111-000000000001';
/** Enough that the walk needs more than one window — the batching is the new code. */
const EXTRA_STORES = STORE_BATCH + 5;

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of chunks) out += chunk;
  return out;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

const req = (headers: Record<string, string> = {}): Request =>
  new Request('https://dezabin.co.il/api/feed/products.xml', { headers });

beforeAll(async () => {
  // Inserted directly, not through `createStore`: a seller may own five stores (MAX_STORES_PER_SELLER)
  // and this needs twenty-five. The cap is a product rule about people, not about what the feed can
  // enumerate, and inventing five sellers to express it would only add noise.
  for (let i = 0; i < EXTRA_STORES; i += 1) {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO stores (id, seller_id, slug, name, colors, created_at)
       VALUES ($1, $2, $3, $4, '{"primary":"#1e7a46","accent":"#f97316"}'::jsonb, now())`,
      [id, DANA, `batch-store-${i}`, `Batch store ${i}`],
    );
    // Priced and pictured, so it is advertisable — an unadvertisable product is a store that
    // contributes to the sitemap and not to the feed, which is true of the fixture already.
    await createProduct(id, {
      name: `Batch product ${i}`,
      price: 10 + i,
      stock: 3,
      images: ['https://res.cloudinary.com/demo/image/upload/sample.jpg'],
    });
  }
});

describe('the streamed feed is the document it replaced', () => {
  it('is byte-identical to the single-shot serialiser over the same catalogue', async () => {
    const stats = newBuildStats();
    const streamed = await collect(feedDocumentChunks(stats));

    const stores = await getIndexableStores();
    const ids = stores.map((s) => s.id);
    const [categories, products, purchased] = await Promise.all([
      getCategoriesByStoreIds(ids),
      getVisibleProductsByStoreIds(ids),
      getPurchasedCountsByStoreSlugs(stores.map((s) => s.slug)),
    ]);
    const meta = feedChannelMeta();
    // One list, unbatched, in store order — so a build that reordered stores across windows, or
    // dropped the separator between the last item of one window and the first of the next, fails
    // here rather than in Merchant Center.
    const items = stores.flatMap((s) =>
      storeFeedItems(s, products.get(s.id) ?? [], categories.get(s.id) ?? [], purchased.get(s.slug) ?? {}, meta.link),
    );

    expect(stores.length).toBeGreaterThan(STORE_BATCH);
    expect(items.length).toBeGreaterThan(0);
    expect(streamed).toBe(toMerchantXml(items, meta));
    expect(stats.items).toBe(items.length);
    expect(stats.stores).toBe(stores.length);
  });

  it('still excludes what it always excluded', async () => {
    const streamed = await collect(feedDocumentChunks(newBuildStats()));
    // The rules themselves live in `getIndexableStores` / `buildFeedItems` and are tested where they
    // live; this is only that the streamed build still asks them. `orphan` has no products, so it
    // contributes nothing whatever the rules say.
    expect(streamed).toContain('<item>');
    expect(streamed).not.toContain('/orphan/');
  });
});

describe('the streamed sitemap is the document it replaced', () => {
  /** Everything the platform sitemap lists, unbatched and unsharded — the expectation. */
  async function allEntries() {
    const stores = await getIndexableStores();
    const ids = stores.map((s) => s.id);
    const [products, categories] = await Promise.all([
      getVisibleProductRefsByStoreIds(ids),
      getCategoriesByStoreIds(ids),
    ]);
    const baseUrl = stripTrailingSlashes(platform.url);
    return stores.flatMap((s) => platformStoreEntries(s, products.get(s.id) ?? [], categories.get(s.id) ?? [], baseUrl) ?? []);
  }

  it('one shard is byte-identical to the single-shot serialiser over the same catalogue', async () => {
    await rebuildSitemapArtifacts();
    const expected = await allEntries();

    const shard = await readArtifactMeta(sitemapShardArtifact(1));
    expect(await drain(artifactStream(shard!))).toBe(buildUrlSetXml(expected));
  });

  it('keeps a store with nothing to sell out of it', async () => {
    const shard = await readArtifactMeta(sitemapShardArtifact(1));
    const xml = await drain(artifactStream(shard!));
    expect(xml).toContain('<loc>');
    expect(xml).not.toContain('/orphan<');
  });

  it('splits past the per-file URL limit and indexes the shards', async () => {
    // The real ceiling is 45,000 URLs a file (the spec allows 50,000 and rejects the file WHOLE
    // above it). Three per shard here, because the boundary is what needs proving and 45,000 rows
    // would prove the same thing in ten minutes.
    const expected = await allEntries();
    expect(expected.length).toBeGreaterThan(6);
    const detail = await rebuildSitemapArtifacts(3);

    const shardCount = Math.ceil(expected.length / 3);
    expect(detail).toContain(`${shardCount} shards`);

    // Every shard is a valid, self-contained urlset, and together they are exactly the same URLs in
    // exactly the same order — a split that lost or reordered one would be invisible in any single
    // file.
    const seen: string[] = [];
    for (let n = 1; n <= shardCount; n += 1) {
      const meta = await readArtifactMeta(sitemapShardArtifact(n));
      const xml = await drain(artifactStream(meta!));
      expect(xml.startsWith('<?xml')).toBe(true);
      expect(xml).toContain('<urlset');
      expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
      seen.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!));
    }
    expect(seen).toEqual(expected.map((e) => e.loc));

    // And the index names each of them, at the URL the shard route actually answers to.
    const index = await drain(artifactStream((await readArtifactMeta(SITEMAP_ARTIFACT))!));
    expect(index).toContain('<sitemapindex');
    const baseUrl = stripTrailingSlashes(platform.url);
    for (let n = 1; n <= shardCount; n += 1) expect(index).toContain(`<loc>${sitemapShardUrl(baseUrl, n)}</loc>`);
    expect([...index.matchAll(/<sitemap>/g)]).toHaveLength(shardCount);
  });

  it('a shard the new build did not write is removed, not left serving a stale slice', async () => {
    // Shrinking is the direction that bites: the index stops naming the extra files, and without
    // this they stay fetchable, holding URLs of a catalogue that no longer exists.
    const before = await readArtifactMeta(sitemapShardArtifact(2));
    expect(before).not.toBeNull();

    await rebuildSitemapArtifacts();
    expect(await readArtifactMeta(sitemapShardArtifact(1))).not.toBeNull();
    expect(await readArtifactMeta(sitemapShardArtifact(2))).toBeNull();

    const res = await serveSitemapShard('2', 'application/xml; charset=utf-8', req());
    expect(res.status).toBe(404);
  });

  it('answers a shard that never existed with 404, not a retry-forever 503', async () => {
    for (const shard of ['99', '0', 'x', '', undefined]) {
      expect((await serveSitemapShard(shard, 'application/xml; charset=utf-8', req())).status).toBe(404);
    }
  });

  it('answers to ONE spelling of shard 1, so the file has one address', async () => {
    // Everything here reads as 1 through `Number()`. A sitemap is not indexed content, so serving it
    // at five URLs is not a duplicate-content problem — it is a document reachable at addresses the
    // index never named.
    for (const spelling of ['01', '1.0', '+1', ' 1', '1e0']) {
      expect((await serveSitemapShard(spelling, 'application/xml; charset=utf-8', req())).status, spelling).toBe(404);
    }
    expect((await serveSitemapShard('1', 'application/xml; charset=utf-8', req())).status).toBe(200);
  });

  it('serves shard 1 with the same frame as any other artifact', async () => {
    const res = await serveSitemapShard('1', 'application/xml; charset=utf-8', req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${CATALOG_ARTIFACT_INTERVAL_SEC}`);
    expect(await res.text()).toContain('<urlset');
  });
});

describe('storage: parts, generations and the swap', () => {
  const NAME = 'test:big-document';

  it('splits a large document into parts and streams them back unchanged', async () => {
    // Three chunks well past the 256KB flush target, so the document is genuinely multi-part and
    // the reader has to put it back together in order.
    const pieces = ['A'.repeat(300_000), 'B'.repeat(300_000), 'C'.repeat(300_000)];
    async function* chunks(): AsyncGenerator<string> {
      for (const piece of pieces) yield piece;
    }

    const meta = await writeArtifact(NAME, chunks(), () => 'three pieces');
    expect(meta.partCount).toBeGreaterThan(1);
    expect(meta.byteSize).toBe(Buffer.byteLength(pieces.join(''), 'utf8'));
    expect(meta.detail).toBe('three pieces');
    expect(await drain(artifactStream(meta))).toBe(pieces.join(''));
  });

  it('a rebuild is invisible until it is finished, and keeps exactly two generations', async () => {
    const first = await readArtifactMeta(NAME);
    async function* chunks(): AsyncGenerator<string> {
      yield 'second version';
    }
    const second = await writeArtifact(NAME, chunks(), () => 'one piece');

    expect(second.generation).toBeGreaterThan(first!.generation);
    // The reader that started on the old generation still finishes — that is what the second
    // generation is kept FOR. A truncated feed is read as a catalogue that shrank.
    expect(await drain(artifactStream(first!))).toContain('A'.repeat(1000));
    expect(await drain(artifactStream(second))).toBe('second version');

    const generations = await query<{ generation: number }>(
      'SELECT DISTINCT generation FROM generated_artifact_parts WHERE name = $1',
      [NAME],
    );
    expect(generations.rows).toHaveLength(2);

    // A third build drops the oldest, so the ceiling is two documents and not a growing pile.
    async function* third(): AsyncGenerator<string> {
      yield 'third version';
    }
    await writeArtifact(NAME, third(), () => 'one piece');
    const after = await query<{ generation: number }>(
      'SELECT DISTINCT generation FROM generated_artifact_parts WHERE name = $1',
      [NAME],
    );
    expect(after.rows).toHaveLength(2);
    expect(await drain(artifactStream((await readArtifactMeta(NAME))!))).toBe('third version');
  });

  it('leaves the live document alone when a build throws', async () => {
    async function* failing(): AsyncGenerator<string> {
      yield 'half a document';
      throw new Error('catalogue read failed');
    }
    await expect(writeArtifact(NAME, failing(), () => 'never')).rejects.toThrow('catalogue read failed');

    const meta = await readArtifactMeta(NAME);
    expect(await drain(artifactStream(meta!))).toBe('third version');
  });
});

describe('the routes serve what the job built', () => {
  it('answers 503 before the first build, and starts one', async () => {
    // The cold path: a database that has never held this document — a first deploy, a fresh
    // environment, or `npm run dev`, where the scheduler is off by design. It must not build the
    // document for the caller, and it must not leave the URL broken forever either.
    expect(await readArtifactMeta(FEED_ARTIFACT)).toBeNull();

    const res = await serveCatalogArtifact(FEED_ARTIFACT, 'application/xml; charset=utf-8', req());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('cache-control')).toBe('no-store');

    await vi.waitFor(async () => expect(await readArtifactMeta(FEED_ARTIFACT)).not.toBeNull(), { timeout: 20_000 });
  });

  it('streams the stored document, with the frame a puller needs', async () => {
    const detail = await rebuildCatalogArtifact(FEED_ARTIFACT);
    expect(detail).toMatch(/stores · \d+ items · \d+ parts · \d+ bytes/);

    const res = await serveCatalogArtifact(FEED_ARTIFACT, 'application/xml; charset=utf-8', req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${CATALOG_ARTIFACT_INTERVAL_SEC}`);
    expect(res.headers.get('etag')).toBeTruthy();

    const body = await res.text();
    expect(body).toBe(await collect(feedDocumentChunks(newBuildStats())));
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(body, 'utf8')));
  });

  it('answers a repeat pull with 304 while the document has not changed', async () => {
    const first = await serveCatalogArtifact(SITEMAP_ARTIFACT, 'application/xml; charset=utf-8', req());
    // First call is the cold 503 for this name; build it and ask properly.
    if (first.status === 503) await rebuildCatalogArtifact(SITEMAP_ARTIFACT);

    const served = await serveCatalogArtifact(SITEMAP_ARTIFACT, 'application/xml; charset=utf-8', req());
    const etag = served.headers.get('etag')!;
    await served.text();

    const repeat = await serveCatalogArtifact(SITEMAP_ARTIFACT, 'application/xml; charset=utf-8', req({ 'if-none-match': etag }));
    expect(repeat.status).toBe(304);
    expect(repeat.headers.get('etag')).toBe(etag);

    // And a rebuild moves the tag, so a stale conditional request gets the new document rather than
    // a 304 forever.
    await rebuildCatalogArtifact(SITEMAP_ARTIFACT);
    const rebuilt = await serveCatalogArtifact(SITEMAP_ARTIFACT, 'application/xml; charset=utf-8', req({ 'if-none-match': etag }));
    expect(rebuilt.status).toBe(200);
    await rebuilt.text();
  });
});
