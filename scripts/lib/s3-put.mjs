// Upload one object to an S3-compatible endpoint (Cloudflare R2), signed with AWS Signature V4.
//
// **Why this is hand-written and not `@aws-sdk/client-s3`.** The application has eight runtime
// dependencies and that is a deliberate property, not an accident of youth: every one of them is a
// thing that can break a `npm ci` on a machine nobody is watching. The AWS SDK is a large tree
// pulled in for exactly one operation — a single `PUT` of a single object, which SigV4 specifies
// completely and which is ~50 lines of `node:crypto`. There is no multipart upload here and there
// will not be: the dump is one file, and a database whose dump outgrows a single PUT (5 GB) has
// outgrown this whole script long before it outgrows the request.
//
// **What makes hand-rolled signing safe to rely on, given that a wrong signature is a backup that
// silently does not exist:** it is verified against the real bucket rather than against a fixture.
// `backup-db.mjs` reads the object back after writing it and compares a SHA-256 of the bytes, so a
// signing change that breaks the upload fails the run instead of logging a success. The known-answer test
// in `tests/s3-put.test.ts` pins the canonical-request and signing-key steps against the vectors in
// AWS's own documentation, so a refactor that breaks the format is caught without the network.
//
// SigV4 reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
import crypto from 'node:crypto';

/**
 * Every request here carries a deadline, for the reason `src/lib/outbound-fetch.ts` exists: Node's
 * `fetch` waits 300 seconds for headers and 300 more for a body, so a provider that has stopped
 * answering without crashing hangs the caller rather than failing it.
 *
 * That module is TypeScript and this file runs under plain `node`, which cannot import it — the
 * same constraint that made `scripts/lib/pg-connect.mjs` a deliberate second copy. But the rule is
 * not waived by being inconvenient to reuse: the shape it forbids is a call with no deadline, and
 * `AbortSignal.timeout` supplies one without importing anything. What differs is only the number.
 * Five minutes, not the seconds a page can afford: this is a batch job uploading a whole database
 * and nobody is waiting on a screen. It sits under the workflow's own 15-minute ceiling, so a stuck
 * transfer fails with a message naming the request instead of being killed as an anonymous timeout.
 */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

const ALGORITHM = 'AWS4-HMAC-SHA256';
// R2 is region-less but SigV4 requires a region in the credential scope, and R2 accepts exactly
// this value. Not a setting: a different string here produces a signature R2 rejects.
export const R2_REGION = 'auto';
const SERVICE = 's3';

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** `20260809T121500Z` and `20260809` — the two forms every SigV4 step needs. */
export function stampsFrom(date) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * Every byte that is not unreserved must be percent-encoded, and `encodeURIComponent` leaves five
 * of them alone (`!'()*`). A key containing one would sign differently than it is sent, which reads
 * as "access denied" and looks like a credentials problem. Slashes are kept literal — the object
 * key is a path, and S3 treats each segment separately.
 */
export function encodeKey(key) {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

/** The four-step derivation. Each step keys the next, so the final key is usable only for this
 *  date, region and service — which is the property that makes a leaked signature nearly worthless. */
export function signingKey(secretAccessKey, dateStamp, region = R2_REGION, service = SERVICE) {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
}

/**
 * The `Authorization` header for one request, plus the headers it commits to.
 *
 * Exported separately from the request so the whole signature can be asserted without a socket —
 * the alternative is a test that needs the network to tell you the format is right, which is the
 * same as no test.
 */
export function signRequest({ method, endpoint, key, payload, accessKeyId, secretAccessKey, date, contentType = '' }) {
  const url = new URL(`${endpoint.replace(/\/+$/, '')}/${encodeKey(key)}`);
  const { amzDate, dateStamp } = stampsFrom(date);
  const payloadHash = sha256Hex(payload ?? '');

  // Sorted by lowercase header name — SigV4 requires the canonical order, and getting it wrong is
  // indistinguishable from a wrong secret in the error R2 returns.
  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(contentType ? { 'content-type': contentType } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method,
    url.pathname,
    '', // no query string on either operation this module performs
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${R2_REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretAccessKey, dateStamp)).update(stringToSign).digest('hex');

  return {
    url: url.toString(),
    canonicalRequest,
    stringToSign,
    headers: {
      ...headers,
      Authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/**
 * PUT one object. Resolves on 2xx and throws with the body otherwise — S3 error bodies name the
 * actual problem (`SignatureDoesNotMatch`, `NoSuchBucket`), and swallowing them is how a broken
 * backup job produces a green log.
 */
export async function putObject({ endpoint, bucket, key, body, accessKeyId, secretAccessKey, contentType = '', date = new Date() }) {
  const signed = signRequest({
    method: 'PUT',
    endpoint,
    key: `${bucket}/${key}`,
    payload: body,
    accessKeyId,
    secretAccessKey,
    date,
    contentType,
  });
  const res = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`R2 PUT ${key} failed: ${res.status} ${res.statusText}\n${(await res.text()).slice(0, 800)}`);
  }
  return { etag: res.headers.get('etag') };
}

/** The digest the read-back compares on. SHA-256 rather than the ETag's MD5 — see `getObject`. */
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * GET one object back, as bytes. Returns null on 404 so a caller can tell "absent" from "broken".
 *
 * **This is the verification, and the two cheaper-looking ways to do it were both tried against the
 * real bucket on 2026-08-09 and both are traps:**
 *
 *   · **By size.** `content-length` reads as `null` through Node's `fetch` — undici does not expose
 *     it on these responses — so a length check reported "0 bytes" for an object that was
 *     verifiably complete. A verification that fails on a working system is exactly as useless as
 *     one that passes on a broken one, and this one would have declared every weekly backup lost.
 *
 *   · **By ETag.** A PUT answered `"2485c0…"` while a HEAD of that same object answered
 *     `W/"2485c0…"` — a weak validator — and a second object in the same run came back strong. So
 *     the format is not stable enough to compare without normalising, the value is an MD5 (a hash
 *     the linter flags, correctly, because reaching for it is usually a mistake), and even matched
 *     it only proves R2 agrees with R2.
 *
 * Reading the bytes back and hashing them locally has none of those problems: it compares what we
 * sent against what is actually retrievable, which is the only question a backup verification is
 * asking. R2 charges nothing for egress (their pricing page, checked 2026-08-09), so the whole cost
 * is a few seconds a week.
 */
export async function getObject({ endpoint, bucket, key, accessKeyId, secretAccessKey, date = new Date() }) {
  const signed = signRequest({
    method: 'GET',
    endpoint,
    key: `${bucket}/${key}`,
    payload: '',
    accessKeyId,
    secretAccessKey,
    date,
  });
  const res = await fetch(signed.url, { method: 'GET', headers: signed.headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}
