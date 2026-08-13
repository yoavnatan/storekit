import { describe, expect, it } from 'vitest';
import { MODERATION_MISSING_MARKER, moderationRefusal, moderationWentMissing, wasModerated } from '../src/lib/image-moderation.js';

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

  it('lets a pending or queued one through — only an explicit NO stops a seller', () => {
    // The case that decides whether this feature is usable at all. Cloudinary's docs point both
    // ways on whether the verdict arrives in the upload response or later via `notification_url`;
    // if it is the latter, EVERY upload comes back `pending`, and refusing that would mean no
    // seller could add a photo from the moment the add-on is switched on. The ambiguity is resolved
    // toward the recoverable failure — see the module header, and GO_LIVE §2.6 for the webhook this
    // leaves open.
    for (const status of ['pending', 'queued']) {
      expect(moderationRefusal({ moderation: [{ status, kind: 'aws_rek' }] })).toBeNull();
    }
    // …but a rejection sitting beside a pending one is still a rejection.
    expect(moderationRefusal({
      moderation: [{ status: 'pending', kind: 'webpurify' }, { status: 'rejected', kind: 'aws_rek' }],
    })).toBeTruthy();
  });

  it('ignores an entry with no readable status instead of guessing', () => {
    expect(moderationRefusal({ moderation: [{ kind: 'aws_rek' }] })).toBeNull();
    expect(moderationRefusal({ moderation: [{ status: 42 }] })).toBeNull();
  });
});

/**
 * The alarm for the failure the verdict itself cannot express.
 *
 * Cloudinary's billing docs: *"Add-ons with a usage quota hit a hard limit instead: when quota runs
 * out, that add-on stops until it renews or you change tier"* — and a stopped add-on's upload
 * response is identical to a never-enabled one's. Without a declared expectation there is nothing
 * in the world that distinguishes them, so the filter would go quiet mid-month with the platform
 * still believing it was on.
 */
describe('a moderation filter cannot switch itself off quietly', () => {
  const unjudged = { secure_url: 'https://res.cloudinary.com/x/a.jpg' };
  const judged = { moderation: [{ status: 'approved', kind: 'aws_rek' }] };

  it('says nothing when no add-on is expected', () => {
    // The default, and today's real state: nothing was promised, so nothing is missing. If this
    // fired while the add-on is off, every seller upload on the platform would file an alert.
    expect(moderationWentMissing(unjudged, false)).toBeNull();
    expect(moderationWentMissing(judged, false)).toBeNull();
  });

  it('raises when an add-on IS expected and no verdict came back', () => {
    const alarm = moderationWentMissing(unjudged, true);
    expect(alarm).toBeTruthy();
    // It has to name both possible causes, because the response cannot tell them apart and the
    // owner's next action differs: switch the add-on on, or wait for the quota to renew.
    expect(alarm).toMatch(/quota/i);
    expect(alarm).toMatch(/NOT being filtered/i);
  });

  it('starts with the marker the admin Overview card looks the state up by', () => {
    // The JOIN, and the reason it is pinned: `image-moderation-health.ts` asks the error log
    // "has this been reported lately" with a LIKE on this prefix, to decide whether the admin's
    // landing page shows "סינון תמונות · נעצר". Reword the sentence without the marker and the
    // card silently stops appearing — the failure would look exactly like a healthy platform,
    // which is the whole class this feature exists to prevent.
    expect(moderationWentMissing(unjudged, true)!.startsWith(MODERATION_MISSING_MARKER)).toBe(true);
    expect(MODERATION_MISSING_MARKER.length).toBeGreaterThan(15);
    // No `%` or `_`: the marker goes into a SQL LIKE pattern, where both are wildcards.
    expect(MODERATION_MISSING_MARKER).not.toMatch(/[%_]/);
  });

  it('stays quiet when the add-on is expected and did run', () => {
    expect(moderationWentMissing(judged, true)).toBeNull();
    // Including the case where it ran and REJECTED — that is the filter working, not missing.
    expect(moderationWentMissing({ moderation: [{ status: 'rejected' }] }, true)).toBeNull();
  });

  it('treats an empty moderation array as not moderated', () => {
    // The shape a stopped add-on could plausibly return, and `[]` is falsy about the only thing
    // that matters: nobody looked at the picture.
    expect(wasModerated({ moderation: [] })).toBe(false);
    expect(moderationWentMissing({ moderation: [] }, true)).toBeTruthy();
    expect(wasModerated(judged)).toBe(true);
  });
});
