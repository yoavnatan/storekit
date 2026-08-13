import { describe, expect, it } from 'vitest';
import { moderationRefusal } from '../src/lib/image-moderation.js';

/**
 * The verdict rules for an uploaded image (`lib/image-moderation.ts`).
 *
 * Driven with the response shapes Cloudinary documents rather than against an account: what is
 * being asserted is our POLICY on a verdict, and the provider's classifier is not ours to test. The
 * shapes below are from its moderation docs (checked 2026-08-13) — a `moderation` array of entries
 * carrying `status` and `kind`.
 */
describe('what the app does with a moderation verdict', () => {
  it('says nothing at all when the add-on is off', () => {
    // The single most important case: no `moderation` key means nothing was checked, and inventing
    // a verdict from silence would be worse than having none. Until the owner enables the add-on
    // (GO_LIVE §2.6) this is EVERY upload, so a refusal here would break all image uploading.
    expect(moderationRefusal({ secure_url: 'https://res.cloudinary.com/x/a.jpg' })).toBeNull();
    expect(moderationRefusal({ moderation: [] })).toBeNull();
    expect(moderationRefusal(undefined)).toBeNull();
    expect(moderationRefusal('not an object')).toBeNull();
  });

  it('accepts an approved image', () => {
    expect(moderationRefusal({ moderation: [{ status: 'approved', kind: 'aws_rek' }] })).toBeNull();
  });

  it('refuses a rejected one', () => {
    const refusal = moderationRefusal({ moderation: [{ status: 'rejected', kind: 'aws_rek' }] });
    expect(refusal).toBeTruthy();
    // A sentence the seller can act on, not a status code — the whole reason `cloudinary.ts` reads
    // the provider's error body instead of throwing "400".
    expect(refusal).toContain('בחר');
  });

  it('refuses when ANY add-on rejected, whatever the others said', () => {
    expect(moderationRefusal({
      moderation: [{ status: 'approved', kind: 'webpurify' }, { status: 'rejected', kind: 'aws_rek' }],
    })).toBeTruthy();
    // `aborted` is the entry that never ran because another moderation had already rejected — it
    // means rejected, not "unknown".
    expect(moderationRefusal({ moderation: [{ status: 'aborted', kind: 'webpurify' }] })).toBeTruthy();
  });

  it('refuses a pending or queued one rather than storing a URL that will not render', () => {
    // Manual moderation parks an asset in `pending` and Cloudinary does not deliver it until a
    // person approves. Treating that as "probably fine" would put an invisible image on a product
    // page. See the module header on why an automatic add-on is the only supported configuration.
    for (const status of ['pending', 'queued']) {
      expect(moderationRefusal({ moderation: [{ status, kind: 'manual' }] })).toBeTruthy();
    }
  });

  it('ignores an entry with no readable status instead of guessing', () => {
    expect(moderationRefusal({ moderation: [{ kind: 'aws_rek' }] })).toBeNull();
    expect(moderationRefusal({ moderation: [{ status: 42 }] })).toBeNull();
  });
});
