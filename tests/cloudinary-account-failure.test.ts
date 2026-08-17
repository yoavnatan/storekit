// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * **An exhausted Cloudinary quota must not look like the seller's fault.**
 *
 * Found live on 2026-08-17 while generating סהר's catalog: every upload came back
 *
 *     420 — Rate Limit Exceeded. Limit of 50 Rekognition AI Moderation operations reached.
 *           Try again on the next monthly billing usage date.
 *
 * The preset carried the image-moderation add-on, the free monthly allowance was spent, and
 * Cloudinary's answer to "I cannot run the add-on this preset demands" is to refuse the upload
 * outright. So a spent moderation quota does not weaken moderation — it takes image UPLOADING down,
 * for the whole account.
 *
 * The owner is the one who named the consequence: *"אבל אם זה ייחסם אז אין למוכרים איך להעלות
 * תמונות"*. He is right, and it is worse than an outage, because the wording that reached the seller
 * was English, blamed nothing, and advised waiting until next month's billing date. A seller reads
 * that as "my photo is broken" and starts deleting good pictures.
 *
 * Three properties are pinned here, and each one failed in production before it existed:
 *
 *   1. The message is Hebrew and says explicitly that the file is not the problem.
 *   2. It is an UPLOAD_REFUSAL — not because the seller can fix it, but because
 *      `products.ts#uploadErrorText` wraps everything else in "נסה שוב", and retrying a spent quota
 *      is the one action guaranteed to fail. A refusal is how this file says "do not press it again".
 *   3. It is REPORTED, once. Nobody but us can act on it, and no seller will describe it accurately.
 *
 * The invoice upload path shares the helper for the same reason: the quota is account-wide, so it
 * blocks a PDF exactly as readily as a photograph.
 */

const reported: string[] = [];
vi.mock('../src/scripts/error-reporter.js', () => ({
  reportClientError: (m: string) => { reported.push(m); },
}));

/**
 * A FRESH copy of the module per test, deliberately.
 *
 * "Report once per page" is held in a module-level flag, which is the right shape for the real thing
 * — a page loads once — and makes tests order-dependent if they share one instance: the first test
 * to hit a 420 spends the flag and every later test sees zero reports. Re-importing per test gives
 * each one its own page, so the assertions say what they mean instead of depending on their order.
 */
async function freshModule() {
  vi.resetModules();
  return import('../src/scripts/dashboard/cloudinary.js');
}

/** The real 420 body, copied from the response that caused all of this. */
const QUOTA_BODY = {
  error: {
    message: 'Rate Limit Exceeded. Limit of 50 Rekognition AI Moderation operations reached. '
      + 'Try again on the next monthly billing usage date.',
  },
};

function respondWith(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })));
}

/** A one-pixel PNG, so the size and format checks upstream of the fetch all pass. */
const PNG = new Blob(
  [Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+wAAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0))],
  { type: 'image/png' },
);

describe('a Cloudinary failure that is ours, not the seller\'s', () => {
  beforeEach(() => { reported.length = 0; });

  it('the moderation-quota 420 becomes a Hebrew refusal that clears the seller', async () => {
    const { cloudinaryUpload, isUploadRefusal } = await freshModule();
    respondWith(420, QUOTA_BODY);
    const err = await cloudinaryUpload(PNG, 'cloud', 'preset').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    // A refusal even though the sentence itself advises retrying: `products.ts#uploadErrorText`
    // appends its own "נסה שוב" to everything that is not one, and it must not be said twice.
    expect(isUploadRefusal(err), 'must be a refusal, or the UI appends "נסה שוב" again').toBe(true);
    // The seller is told it is temporary and what to do — never sent to inspect their own file, and
    // never shown the vendor's English.
    expect((err as Error).message).toContain('תקלה זמנית');
    expect((err as Error).message).not.toMatch(/Rekognition|Rate Limit|billing/i);
  });

  it('reports it to us once per page, not once per photo in a bulk upload', async () => {
    const { cloudinaryUpload } = await freshModule();
    respondWith(420, QUOTA_BODY);
    for (let i = 0; i < 4; i++) await cloudinaryUpload(PNG, 'cloud', 'preset').catch(() => {});

    expect(reported).toHaveLength(1);
    // The vendor's own sentence belongs in the REPORT — that is what made this diagnosable at all.
    expect(reported[0]).toContain('Rekognition');
  });

  it('catches a quota refusal arriving under some other status', async () => {
    // The status is an implementation detail; the wording is what Cloudinary documents.
    const { cloudinaryUpload, isUploadRefusal } = await freshModule();
    respondWith(400, QUOTA_BODY);
    const err = await cloudinaryUpload(PNG, 'cloud', 'preset').catch((e: unknown) => e);
    expect(isUploadRefusal(err)).toBe(true);
  });

  it('leaves an ordinary provider error alone, with the vendor sentence intact', async () => {
    // The whole reason `uploadFailure` reads the body at all: a plain 400 must keep saying why, or a
    // fixable upload becomes a mystery again.
    const { cloudinaryUpload, isUploadRefusal } = await freshModule();
    respondWith(400, { error: { message: 'Invalid image file' } });
    const err = await cloudinaryUpload(PNG, 'cloud', 'preset').catch((e: unknown) => e);
    expect(isUploadRefusal(err), 'a bad file is not an account failure').toBe(false);
    expect((err as Error).message).toBe('Invalid image file');
    expect(reported, 'a fixable file error is the seller\'s to see, not ours to log').toHaveLength(0);
  });

  it('the invoice path shares it — the quota is account-wide', async () => {
    const { cloudinaryUploadInvoice, isUploadRefusal } = await freshModule();
    respondWith(420, QUOTA_BODY);
    const pdf = new File([new Uint8Array([1, 2, 3])], 'invoice.pdf', { type: 'application/pdf' });
    const err = await cloudinaryUploadInvoice(pdf, 'cloud', 'preset').catch((e: unknown) => e);
    expect(isUploadRefusal(err)).toBe(true);
    expect((err as Error).message).toContain('תקלה זמנית');
  });
});
