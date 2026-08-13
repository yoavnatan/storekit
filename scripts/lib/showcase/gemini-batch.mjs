/**
 * Gemini Batch mode — the same image models at half price, in exchange for waiting.
 *
 * Google's wording is "Batch API usage is priced at 50% of the standard interactive API cost for
 * the equivalent model", with a stated 24-hour turnaround. Across the ~724 images the showcase
 * catalog needs that is the difference between $73 and $37, which is the whole reason this file
 * exists — see the cost table in `npm run showcase:images -- --cost`.
 *
 * The 24 hours is an allowance, not a wait: a two-image job measured on 2026-08-12 finished in
 * about two minutes. Plan for the allowance, expect much less, and don't reach for the interactive
 * path just because the run is wanted today.
 *
 * Every image model reports `batchGenerateContent` in its `supportedGenerationMethods`, checked
 * against the live ListModels response on 2026-08-12 rather than taken from the docs page.
 *
 * ── Why file-based and not inline ───────────────────────────────────────────
 * The API takes requests either inline in the create call or as an uploaded JSONL. The requests
 * here are tiny (a prompt is ~1.5KB) so inline would fit easily — but the RESPONSES are images,
 * ~3MB of base64 each, and inline responses come back inside the poll response as one JSON
 * document. A hundred of those is a 400MB `JSON.parse`. The uploaded-file route returns a results
 * FILE instead, which streams to disk and is read a line at a time, so memory stays flat no matter
 * how large the chunk is.
 *
 * ── What this module does NOT do ────────────────────────────────────────────
 * It has no idea what an image is. It takes prompts in and gives raw response envelopes back,
 * keyed by whatever key the caller chose; extracting bytes, uploading to Cloudinary and writing
 * the manifest all stay in `generate-showcase-images.mjs`, which owns those decisions already.
 */
import { createWriteStream, createReadStream, statSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';

const API = 'https://generativelanguage.googleapis.com';

const authed = (apiKey, extra = {}) => ({ 'x-goog-api-key': apiKey, ...extra });

async function expectOk(res, what) {
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  throw new Error(`${what}: HTTP ${res.status} — ${body.slice(0, 400)}`);
}

/**
 * One JSONL line per request. The `key` is what comes back on the response line, and it is the
 * caller's own manifest key — so a result never has to be matched up by position, which is the
 * thing that silently mis-assigns pictures to products when a request fails and the rows shift.
 */
export function jsonlLine(key, model, prompt, aspect, size, reference = null) {
  // A reference image goes first in the parts array, ahead of the text — same shape and same
  // reason as the interactive path in `generate-showcase-images.mjs`.
  const parts = reference
    ? [{ inline_data: { mime_type: 'image/jpeg', data: reference.toString('base64') } }, { text: prompt }]
    : [{ text: prompt }];
  return `${JSON.stringify({
    key,
    request: {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: aspect, imageSize: size },
      },
    },
  })}\n`;
}

/** Upload a JSONL through the File API's resumable protocol, and return its `files/…` name. */
export async function uploadJsonl(apiKey, path, displayName) {
  const bytes = statSync(path).size;
  const start = await expectOk(await fetch(`${API}/upload/v1beta/files`, {
    method: 'POST',
    headers: authed(apiKey, {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes),
      'X-Goog-Upload-Header-Content-Type': 'application/jsonl',
      'content-type': 'application/json',
    }),
    body: JSON.stringify({ file: { display_name: displayName } }),
  }), 'batch file upload (start)');

  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('batch file upload: the API returned no X-Goog-Upload-URL');

  const done = await expectOk(await fetch(uploadUrl, {
    method: 'POST',
    headers: authed(apiKey, {
      'Content-Length': String(bytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    }),
    body: readFileSync(path),
  }), 'batch file upload (finalize)');

  const name = (await done.json())?.file?.name;
  if (!name) throw new Error('batch file upload: the API returned no file name');
  return name;
}

/** Create the batch job over an uploaded file. Returns the operation name to poll. */
export async function createBatch(apiKey, model, fileName, displayName) {
  const res = await expectOk(await fetch(`${API}/v1beta/models/${model}:batchGenerateContent`, {
    method: 'POST',
    headers: authed(apiKey, { 'content-type': 'application/json' }),
    body: JSON.stringify({ batch: { display_name: displayName, input_config: { file_name: fileName } } }),
  }), 'batch create');
  const name = (await res.json())?.name;
  if (!name) throw new Error('batch create: the API returned no operation name');
  return name;
}

/**
 * One poll. Returns `{ state, done, responsesFile, error }` — the shape the caller acts on.
 *
 * **The state strings are `BATCH_STATE_*`, not the `JOB_STATE_*` the documentation prints** —
 * observed on a real job, 2026-08-12: `BATCH_STATE_RUNNING` then `BATCH_STATE_SUCCEEDED`. So a
 * caller must match on the SUFFIX (`/SUCCEEDED|FAILED|CANCELLED|EXPIRED/`) and never on the whole
 * documented constant, which would wait forever on a job that had already finished.
 */
export async function getBatch(apiKey, operationName) {
  const res = await expectOk(await fetch(`${API}/v1beta/${operationName}`, { headers: authed(apiKey) }), 'batch poll');
  const op = await res.json();
  return {
    state: op?.metadata?.state ?? (op?.done ? 'BATCH_STATE_SUCCEEDED' : 'BATCH_STATE_PENDING'),
    done: Boolean(op?.done),
    responsesFile: op?.response?.responsesFile ?? op?.response?.dest?.fileName ?? null,
    inlined: op?.response?.inlinedResponses?.inlinedResponses ?? null,
    error: op?.error ? `${op.error.code}: ${op.error.message}` : null,
  };
}

/** Stream the results file to disk. It is hundreds of megabytes of base64 — never buffer it. */
export async function downloadResults(apiKey, fileName, destPath) {
  const res = await expectOk(
    await fetch(`${API}/download/v1beta/${fileName}:download?alt=media`, { headers: authed(apiKey) }),
    'batch results download',
  );
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
  return destPath;
}

/** Read the results a line at a time: `{ key, response, error }` per row. */
export async function* readResults(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    yield {
      key: row.key ?? row.metadata?.key ?? null,
      response: row.response ?? null,
      error: row.error ? `${row.error.code ?? ''}: ${row.error.message ?? JSON.stringify(row.error).slice(0, 200)}` : null,
    };
  }
}
