/**
 * Pre-built public documents: written by a job, served by a route, never assembled in a request.
 *
 * **The rule this module exists to make mechanical.** A public route may not build an unbounded
 * result set. `/api/feed/products.xml` and `/sitemap-content.xml` did — the whole platform
 * catalogue into one string, per request, on the single event loop every shopper shares (6.1
 * seconds at 45 stores, measured in this repo; a several-hundred-MB string and an OOM at a
 * thousand sellers). Migration 0022 carries the storage rationale. This file is the seam: a builder
 * hands over a stream of text, a route hands back bytes, and neither knows the other exists.
 *
 * **Nothing here ever holds the whole document.** The writer buffers to `PART_TARGET_CHARS` and
 * flushes; the reader streams one part at a time. That bound is the point — the memory ceiling of
 * both sides is one part, whatever the catalogue grows to.
 *
 * **And the writer awaits, which is what keeps the process responsive.** Chunking is not only about
 * memory: a `for await` that hits a real insert every ~256KB hands the event loop back that often,
 * so a build running in the same process as a checkout interleaves with it instead of blocking it
 * for seconds. A builder that yielded the whole document as one chunk would still be correct here
 * and would still block — which is why the builders yield per item.
 *
 * Guarded by `tests/public-route-unbounded-build.test.ts`, which scans `src/pages/` rather than a
 * file list, so the next route that fans out over every store fails the suite instead of shipping.
 */
import { query, rows, firstRow, withTransaction } from './db.js';

/** Flush a part once the buffer passes this. Chosen as "big enough that the per-part round trip is
 *  noise, small enough that a part is a rounding error in a process's memory". Not a correctness
 *  value — any size produces the same document, because the separators are inside the text. */
const PART_TARGET_CHARS = 256 * 1024;

export interface ArtifactMeta {
  name: string;
  generation: number;
  builtAt: string;
  partCount: number;
  byteSize: number;
  detail: string;
}

interface MetaRow {
  name: string;
  live_generation: number;
  built_at: Date | string;
  part_count: number;
  byte_size: number;
  detail: string;
}

function toMeta(row: MetaRow): ArtifactMeta {
  return {
    name: row.name,
    generation: Number(row.live_generation),
    builtAt: row.built_at instanceof Date ? row.built_at.toISOString() : String(row.built_at),
    partCount: row.part_count,
    byteSize: Number(row.byte_size),
    detail: row.detail,
  };
}

/** What is being served right now, or `null` if this document has never been built. */
export async function readArtifactMeta(name: string): Promise<ArtifactMeta | null> {
  const row = await firstRow<MetaRow>(
    'SELECT name, live_generation, built_at, part_count, byte_size, detail FROM generated_artifacts WHERE name = $1',
    [name],
  );
  return row ? toMeta(row) : null;
}

/**
 * An open document: write text at it, close it, and it becomes live.
 *
 * **Why a writer and not only `writeArtifact`.** One walk of the catalogue can produce SEVERAL
 * documents — the sitemap is capped at 45,000 URLs a file, so a large platform is a handful of
 * shards plus an index, and none of their boundaries are known before the walk reaches them. A
 * function that takes a finished stream of chunks cannot express "close this one here and open the
 * next", and re-walking the mall once per shard would multiply the only expensive part of the job.
 *
 * Nothing is visible until `close`: parts are written under a fresh generation and the pointer moves
 * at the end. Abandoning a writer (a throw, an early return) leaves orphan parts and the previous
 * document still serving — the next successful publish clears them.
 */
export class ArtifactWriter {
  private buffer = '';
  private idx = 0;
  private byteSize = 0;

  private constructor(private readonly name: string, private readonly generation: number) {}

  static async open(name: string): Promise<ArtifactWriter> {
    return new ArtifactWriter(name, await nextGeneration());
  }

  async write(chunk: string): Promise<void> {
    this.buffer += chunk;
    if (this.buffer.length >= PART_TARGET_CHARS) await this.flush();
  }

  async close(detail: string): Promise<ArtifactMeta> {
    await this.flush();
    return publishArtifact(this.name, this.generation, this.idx, this.byteSize, detail);
  }

  private async flush(): Promise<void> {
    if (!this.buffer) return;
    await query('INSERT INTO generated_artifact_parts (name, generation, idx, body) VALUES ($1, $2, $3, $4)', [
      this.name,
      this.generation,
      this.idx,
      this.buffer,
    ]);
    this.byteSize += Buffer.byteLength(this.buffer, 'utf8');
    this.idx++;
    this.buffer = '';
  }
}

/**
 * Build `name` from `chunks` and publish it when the last chunk has landed.
 *
 * `chunks` is consumed exactly once and its concatenation IS the document — this function adds no
 * separator, header or newline of its own, so a builder can be compared byte for byte against the
 * single-shot serialiser it replaces (`tests/catalog-artifacts.test.ts` does exactly that).
 */
export async function writeArtifact(
  name: string,
  chunks: AsyncIterable<string>,
  detail: () => string,
): Promise<ArtifactMeta> {
  const writer = await ArtifactWriter.open(name);
  for await (const chunk of chunks) await writer.write(chunk);
  return writer.close(detail());
}

/**
 * Drop documents whose name starts with `prefix` and that are not in `keep`.
 *
 * **The failure this exists for is a sitemap that SHRANK.** Shards are numbered, so a platform that
 * goes from seven files to three leaves `…-4` … `…-7` sitting there, each serving a stale slice of
 * the catalogue: URLs of stores that closed, prices from before, and nothing in the index pointing
 * at them — which is worse than either extreme, because they stay fetchable by anything that
 * remembers them. The rebuild names what it wrote and everything else under the prefix goes.
 */
export async function pruneArtifacts(prefix: string, keep: readonly string[]): Promise<number> {
  // `starts_with`, not `LIKE $1 || '%'`: in LIKE an `_` matches ANY character, so a prefix
  // containing one would quietly delete a neighbour's documents. No artifact name has an underscore
  // today, which is precisely the kind of fact that stops being true without anyone noticing.
  return withTransaction(async (tx) => {
    const removed = await tx.query(
      'DELETE FROM generated_artifacts WHERE starts_with(name, $1) AND name <> ALL($2::text[])',
      [prefix, keep],
    );
    await tx.query(
      'DELETE FROM generated_artifact_parts WHERE starts_with(name, $1) AND name <> ALL($2::text[])',
      [prefix, keep],
    );
    return removed.rowCount;
  });
}

async function nextGeneration(): Promise<number> {
  const row = await firstRow<{ g: number | string }>("SELECT nextval('generated_artifact_generation_seq') AS g");
  return Number(row?.g ?? 1);
}

/**
 * Move the pointer, in one transaction, and drop everything two generations old.
 *
 * **Two are kept on purpose.** A reader that started streaming a moment before the swap is still
 * asking for parts of the generation it began with; deleting them under it would truncate a feed
 * mid-document, which is worse than serving it a version that is one interval stale. One rebuild
 * interval of grace is far longer than any pull takes, and the ceiling stays at twice the document
 * — a bound, not a growing pile.
 */
async function publishArtifact(
  name: string,
  generation: number,
  partCount: number,
  byteSize: number,
  detail: string,
): Promise<ArtifactMeta> {
  return withTransaction(async (tx) => {
    const previous = await tx.query<{ live_generation: number }>(
      'SELECT live_generation FROM generated_artifacts WHERE name = $1 FOR UPDATE',
      [name],
    );
    const keep = previous.rows[0] ? [generation, Number(previous.rows[0].live_generation)] : [generation];
    const published = await tx.query<MetaRow>(
      `INSERT INTO generated_artifacts (name, live_generation, built_at, part_count, byte_size, detail)
            VALUES ($1, $2, now(), $3, $4, $5)
       ON CONFLICT (name) DO UPDATE
              SET live_generation = EXCLUDED.live_generation,
                  built_at        = EXCLUDED.built_at,
                  part_count      = EXCLUDED.part_count,
                  byte_size       = EXCLUDED.byte_size,
                  detail          = EXCLUDED.detail
        RETURNING name, live_generation, built_at, part_count, byte_size, detail`,
      [name, generation, partCount, byteSize, detail],
    );
    // Everything that is neither the new document nor the one it replaced: the generation that has
    // now aged out, plus the parts of any build that died before it could publish.
    await tx.query('DELETE FROM generated_artifact_parts WHERE name = $1 AND generation <> ALL($2::bigint[])', [
      name,
      keep,
    ]);
    return toMeta(published.rows[0]!);
  });
}

/**
 * How many parts one read fetches.
 *
 * **Measured against a real remote Postgres, on the built server, twice.** A part per query looked
 * like the tidy answer and served a 2.5MB feed in **3.3s** — ten parts, ten round trips. A window of
 * eight takes it to **2.1–2.5s**, and that remainder is the honest floor: it is the document itself
 * crossing the network from Neon, not latency, so no window size removes it. Eight parts is ~2MB in
 * flight per reader, a rounding error against a process.
 *
 * It is a READ-side constant and not the part size on purpose — the writer's rhythm (flush often, so
 * the event loop is handed back often) and the reader's batch answer different questions, and tying
 * them together is what made the first version slow.
 *
 * **The remaining second is buyable and deliberately not bought yet.** Storing each part gzipped
 * would cut both the database transfer and the egress to Google by roughly ten, and it composes
 * cleanly (concatenated gzip members are one valid gzip stream, so parts stay independently
 * streamable). It costs a `bytea` column, a decompress path for a client that does not accept gzip,
 * and PGlite behaviour to re-check. Not worth it while the document is single-digit MB and a CDN
 * holds it for half an hour. TRIGGER: the feed passes ~20MB, or a fetch from Merchant Center is
 * observed timing out.
 */
const READ_WINDOW = 8;

/** Parts `from…from+limit-1`, in order. Short (or empty) means the generation has no more. */
async function readParts(name: string, generation: number, from: number, limit: number): Promise<string[]> {
  const found = await rows<{ body: string }>(
    `SELECT body FROM generated_artifact_parts
      WHERE name = $1 AND generation = $2 AND idx >= $3
      ORDER BY idx
      LIMIT $4`,
    [name, generation, from, limit],
  );
  return found.map((r) => r.body);
}

/**
 * The document as a stream, a window of parts per read.
 *
 * A part that has gone missing errors the stream rather than ending it: a short document is a
 * catalogue that appears to have shrunk, and every consumer of these two URLs acts on that. A
 * broken connection is read as a fetch failure and retried; a truncated feed is read as the truth.
 */
export function artifactStream(meta: ArtifactMeta): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let fetched = 0;
  let emitted = 0;
  let queue: string[] = [];
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!queue.length && fetched < meta.partCount) {
        queue = await readParts(meta.name, meta.generation, fetched, READ_WINDOW);
        fetched += queue.length;
      }
      if (!queue.length) {
        if (emitted === meta.partCount) controller.close();
        else controller.error(new Error(`artifact "${meta.name}" generation ${meta.generation} is missing part ${emitted}`));
        return;
      }
      emitted++;
      controller.enqueue(encoder.encode(queue.shift()!));
    },
  });
}

/**
 * Serve `meta` as `contentType`, honouring a conditional request.
 *
 * **The ETag is the generation**, so it changes exactly when the document does and never otherwise —
 * two instances serving the same generation agree on it, which a hash of the bytes would also give
 * but only after reading all of them. Both platforms pull on a schedule whether or not anything
 * changed, and a catalogue that did not change is the common case: a 304 turns that pull into a
 * header exchange instead of tens of megabytes.
 *
 * `maxAgeSec` is the caller's, and it is meant to be the REBUILD INTERVAL — see
 * `catalog-artifacts.ts`, where the two are one constant.
 */
export function artifactResponse(meta: ArtifactMeta, contentType: string, request: Request, maxAgeSec: number): Response {
  const etag = `"${meta.name}:${meta.generation}"`;
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': `public, max-age=${maxAgeSec}`,
    ETag: etag,
    'Last-Modified': new Date(meta.builtAt).toUTCString(),
  };
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(artifactStream(meta), {
    status: 200,
    // Counted while writing, from the same strings. A puller fetching a large feed gets a progress
    // bar and a truncation check for free.
    headers: { ...headers, 'Content-Length': String(meta.byteSize) },
  });
}

/**
 * What a route answers when the document has never been built.
 *
 * **503, never an empty 200.** An empty feed is a valid document that says every product on the
 * platform is gone, and Merchant Center acts on it; an empty sitemap says the same to Google. 503
 * is the one answer both are documented to treat as "ask again later", and it is honest: the server
 * is not able to serve this yet. `Retry-After` is short because the gap only exists between a cold
 * boot and the first build.
 */
export function artifactUnavailable(): Response {
  return new Response('artifact not built yet\n', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60', 'Cache-Control': 'no-store' },
  });
}

/** Names of every artifact currently stored. Admin/diagnostic use — no request path reads it. */
export async function listArtifacts(): Promise<ArtifactMeta[]> {
  const found = await rows<MetaRow>(
    'SELECT name, live_generation, built_at, part_count, byte_size, detail FROM generated_artifacts ORDER BY name',
  );
  return found.map(toMeta);
}
