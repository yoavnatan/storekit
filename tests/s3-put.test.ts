/**
 * The signing and verification a backup upload rests on.
 *
 * **Why a test at all, when the upload was verified against the real bucket.** It was, and that is
 * what caught the two things below that no fixture would have. But that check ran once, by hand,
 * with live credentials; nothing in CI has those, and nothing would notice a refactor that broke the
 * canonical-request format. The failure mode is the reason to care: a wrong signature does not
 * corrupt anything — it means no file was ever written, on a schedule, with the run reported as
 * whatever the caller decided to report. So the format is pinned against AWS's own published
 * example, which is the one comparison that does not need a network or a secret.
 *
 * **Why the upload is verified by reading the object back, and not the two obvious cheaper ways.**
 * Both were tried against the real bucket on 2026-08-09 and both would have failed every weekly
 * backup while the data sat safely in R2: `content-length` is absent from Node `fetch` responses
 * (so a size check reads 0), and R2 answers with a weak ETag (`W/"…"`) for one object and a strong
 * one for the next in the same run (so a string compare is a coin flip). The reasoning lives on
 * `getObject`; what is pinned here is the signing those requests depend on.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { signRequest, signingKey, encodeKey, stampsFrom, sha256 } from '../scripts/lib/s3-put.mjs';

describe('SigV4 — pinned against AWS documented vectors', () => {
  it('derives the signing key exactly as the specification worked example does', () => {
    // The worked example from AWS's "Signature Version 4 signing process" documentation. Any change
    // to the four-step derivation changes this hex and fails here.
    const key: Buffer = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
    expect(key.toString('hex')).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  });

  it('builds a canonical request with sorted, newline-terminated headers and the payload hash', () => {
    const payload = Buffer.from('hello');
    const { canonicalRequest, headers } = signRequest({
      method: 'PUT',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      key: 'bucket/file.sql.gz',
      payload,
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      date: new Date('2026-08-09T12:15:00.000Z'),
      contentType: 'application/gzip',
    });
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    expect(canonicalRequest).toBe([
      'PUT',
      '/bucket/file.sql.gz',
      '',
      'content-type:application/gzip\n' +
      'host:acct.r2.cloudflarestorage.com\n' +
      'x-amz-content-sha256:' + hash + '\n' +
      'x-amz-date:20260809T121500Z\n',
      'content-type;host;x-amz-content-sha256;x-amz-date',
      hash,
    ].join('\n'));
    expect(headers.Authorization).toContain('Credential=AKID/20260809/auto/s3/aws4_request');
  });

  it('signs the same request identically twice — the signature depends on nothing ambient', () => {
    const args = {
      method: 'PUT', endpoint: 'https://acct.r2.cloudflarestorage.com', key: 'b/k',
      payload: Buffer.from('x'), accessKeyId: 'A', secretAccessKey: 'S',
      date: new Date('2026-08-09T12:15:00.000Z'),
    };
    expect(signRequest(args).headers.Authorization).toBe(signRequest(args).headers.Authorization);
  });

  it('stamps the two date forms SigV4 needs', () => {
    expect(stampsFrom(new Date('2026-08-09T12:15:00.000Z'))).toEqual({ amzDate: '20260809T121500Z', dateStamp: '20260809' });
  });

  it('percent-encodes the characters encodeURIComponent leaves alone, and keeps path separators', () => {
    // A key carrying one of these would be signed differently than it is sent, which R2 reports as
    // an access failure — indistinguishable from a bad secret.
    expect(encodeKey("bucket/it's (a) file!.gz")).toBe('bucket/it%27s%20%28a%29%20file%21.gz');
    expect(encodeKey('a/b/c.gz')).toBe('a/b/c.gz');
  });
});

describe('the object key', () => {
  it('sorts chronologically as plain text and carries no colon', async () => {
    // Both are stated properties of the name and neither is obvious from reading it. Sorting as
    // text is what makes "the latest backup" answerable by listing the bucket, with no metadata.
    // The colons go because S3 keys allow them and Windows filenames do not — a restore should
    // never be blocked by which machine the file was downloaded onto.
    const { backupKey } = await import('../scripts/backup-db.mjs');
    const earlier = backupKey(new Date('2026-08-09T12:15:00.000Z'));
    const later = backupKey(new Date('2026-12-01T02:00:00.000Z'));

    expect(earlier).toBe('dezabin-2026-08-09T12-15-00Z.sql.gz');
    expect(earlier < later).toBe(true);
    expect(earlier).not.toContain(':');
  });
});

describe('the read-back comparison', () => {
  it('agrees byte-for-byte with itself and disagrees on a single flipped byte', () => {
    // The whole verification is `sha256(sent) === sha256(readBack)`, so what has to be true is that
    // it separates a good round trip from a subtly damaged one — the case a length check misses.
    const sent = Buffer.from('-- pg_dump output\n'.repeat(500));
    const truncated = sent.subarray(0, sent.byteLength - 1);
    const altered = Buffer.from(sent);
    altered[altered.byteLength - 1] = 0x00;

    expect(sha256(Buffer.from(sent))).toBe(sha256(sent));
    expect(sha256(truncated)).not.toBe(sha256(sent));
    expect(sha256(altered)).not.toBe(sha256(sent));
  });

  it('is a real SHA-256 and not a stand-in that would pass on anything', () => {
    expect(sha256(Buffer.from('abc'))).toBe(crypto.createHash('sha256').update('abc').digest('hex'));
  });
});
