/**
 * What a hold MEANS, pinned — because two edits that were each right made it mean two things.
 *
 * ── The bug this exists for (owner, 2026-08-25) ──
 * *"נראה שלא, כי הכל אצלי ירוק עכשיו אבל החנות עדיין לא באוויר ובסקירה הכללית עדיין מפנים להשלמת
 * הפרטים."* Every step on the payments tab was ticked, the shop was dark, and the overview was still
 * asking for details that had been given. Three screens, three different answers, one seller.
 *
 * The cause was a shared assumption going stale rather than a mistake in any one place. Until
 * 2026-08-25 the clearing account was opened the moment the details form saved, so **no account**
 * and **no details** were the same fact, and code all over the flow leaned on that:
 *
 *   - `publishHoldsFor` pushed `clearing-details` on `no-account`
 *   - `GoLiveSteps` read step 3 as `detailsDone && !holds.includes('clearing-approval')`
 *   - the details form locked itself on the same `detailsDone`
 *
 * Moving the account to card-save (it costs ₪65/month for as long as it exists, so it waits for a
 * commitment) split that one fact in two, and each of those three read the half that suited it.
 * The worst was step 3: PayMe had never been asked about this business, so there was no approval
 * hold, so "not blocked" rendered as a green tick for a review that did not exist.
 *
 * ── The rule, stated once so it can be tested ──
 * **A hold says what is BLOCKING. Its absence covers both "finished" and "never started", so it can
 * never be read as an achievement.** Anything claiming something is DONE must read the thing itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rig = {
  subscribed: false,
  block: null as 'no-account' | 'not-approved' | null,
  kyc: {} as Record<string, unknown>,
};

vi.mock('../src/lib/payment-payme.js', () => ({
  activePaymeCredentials: () => ({ partnerId: 'p', partnerKey: 'k', baseUrl: 'https://preprod.paymeservice.com' }),
}));
vi.mock('../src/lib/seller-subscription.js', () => ({ sellerIsSubscribed: async () => rig.subscribed }));
vi.mock('../src/lib/seller-merchant.js', () => ({
  merchantBlockFor: async () => rig.block,
  merchantKycFor: async () => rig.kyc,
}));
vi.mock('../src/lib/merchant-kyc.js', () => ({
  // Only the fields the rig sets count as given; anything else is "missing".
  missingMerchantKyc: (kyc: Record<string, unknown>) => (Object.keys(kyc).length ? [] : ['businessId']),
}));

const { publishHoldsFor } = await import('../src/lib/store-publication.js');

beforeEach(() => {
  rig.subscribed = false;
  rig.block = null;
  rig.kyc = {};
});

describe('publishHoldsFor', () => {
  it('asks for details when they are genuinely missing', async () => {
    rig.block = 'no-account';
    expect(await publishHoldsFor('seller-1')).toContain('clearing-details');
  });

  /**
   * The regression itself. A seller who has typed every field PayMe require has no account yet —
   * the account waits for his card — and telling him details are missing sent him back to a form he
   * had finished, while the payments tab showed the same form ticked.
   */
  it('does NOT ask for details once they are all given, even with no account open', async () => {
    rig.block = 'no-account';
    rig.kyc = { businessId: '123' };
    const holds = await publishHoldsFor('seller-1');
    expect(holds).not.toContain('clearing-details');
    // What he is actually waiting on is his own card, and that hold was always there. One gap, one
    // hold — two was how the overview and the payments tab started disagreeing.
    expect(holds).toContain('subscription');
  });

  it('never reports an approval hold for a review nobody asked for', async () => {
    // No account ⇒ nothing to approve. This is the absence that was being read as a green tick, and
    // the assertion exists to keep it an absence rather than to make it a hold: the fix belongs in
    // the reader, not here.
    rig.block = 'no-account';
    rig.kyc = { businessId: '123' };
    expect(await publishHoldsFor('seller-1')).not.toContain('clearing-approval');
  });

  it('reports the approval hold once PayMe actually have the business', async () => {
    rig.block = 'not-approved';
    rig.kyc = { businessId: '123' };
    expect(await publishHoldsFor('seller-1')).toContain('clearing-approval');
  });

  it('holds nothing once the account is approved and the subscription runs', async () => {
    rig.block = null;
    rig.subscribed = true;
    rig.kyc = { businessId: '123' };
    expect(await publishHoldsFor('seller-1')).toEqual([]);
  });
});

describe('the go-live steps', () => {
  /**
   * Source-level, because the failure was a *reading* of the holds and no rendered output would
   * have looked wrong on the day it was written — it only became wrong when a different file
   * changed. What is pinned is that step 3 asks the account, not the hold list.
   */
  it('decides the approval step from the account, never from a missing hold', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/components/dashboard/GoLiveSteps.astro', 'utf8');
    const line = src.split('\n').find((l) => l.startsWith('const approvalDone'));
    expect(line).toBeDefined();
    expect(line).toContain("clearing?.state === 'ready'");
    expect(line).not.toContain('holds');
  });

  it('leaves the details form editable until a processor really holds it', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/components/dashboard/GoLiveSteps.astro', 'utf8');
    // `sent` is about PayMe, `detailsDone` is about the seller. Binding one to the other locked the
    // form the moment he finished typing — before anyone had the details, and before the last
    // chance to fix a typo in a company number nobody downstream will amend.
    expect(src).not.toContain('sent={detailsDone}');
    expect(src).toContain("sent={clearing?.state === 'awaiting-approval'}");
  });
});
