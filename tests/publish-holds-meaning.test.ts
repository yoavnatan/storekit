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
  /** A card on file, PayMe not yet billing. */
  armed: false,
  block: null as 'no-account' | 'not-approved' | null,
  /** What PayMe still want. Empty = the account can be opened. */
  missing: [] as string[],
};

vi.mock('../src/lib/payment-payme.js', () => ({
  activePaymeCredentials: () => ({ partnerId: 'p', partnerKey: 'k', baseUrl: 'https://preprod.paymeservice.com' }),
}));
vi.mock('../src/lib/seller-subscription.js', () => ({
  sellerIsSubscribed: async () => rig.subscribed,
  // Whether a card is already on file. It does not clear the subscription hold — nothing has been
  // charged — but it decides which hold is reported FIRST, and the overview shows the first as the
  // reason a seller is given.
  subscriptionFor: async () => (rig.armed ? { cardSavedAt: '2026-08-25' } : null),
  subscriptionArmed: (sub: unknown) => !!sub,
}));
vi.mock('../src/lib/seller-merchant.js', () => ({
  merchantBlockFor: async () => rig.block,
  // ONE question — the same one `ensureMerchantAccount` asks. It counts the bank block and the
  // business type as well as the ten KYC fields, which is the whole point of it existing: checking
  // only the second set let a seller with an empty bank block reach a card form and see a tick.
  missingForClearingAccount: async () => rig.missing,
}));

const { publishHoldsFor } = await import('../src/lib/store-publication.js');

beforeEach(() => {
  rig.subscribed = false;
  rig.block = null;
  rig.missing = ['businessId'];
  rig.armed = false;
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
    rig.missing = [];
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
    rig.missing = [];
    expect(await publishHoldsFor('seller-1')).not.toContain('clearing-approval');
  });

  it('reports the approval hold once PayMe actually have the business', async () => {
    rig.block = 'not-approved';
    rig.missing = [];
    expect(await publishHoldsFor('seller-1')).toContain('clearing-approval');
  });

  /**
   * ── Which hold is reported FIRST, because the overview shows the first as the reason ──
   *
   * Owner, 2026-08-25: *"בעמוד של הסקירה עדיין יש כפתור 'העלה את החנות לאוויר' למרות שעשיתי את 2
   * השלבים וכרגע אני ממתין לאישור."* Both holds were true — nothing had been charged, so the shop
   * was rightly down — but the one shown was the one he had already done, with a button offering to
   * start a subscription he had started. It reads as the last step having failed.
   *
   * The gate is unchanged and that is the point of testing both together: publication still needs
   * both to clear, and only the ORDER moves.
   */
  it('names the approval wait first once a card is already on file', async () => {
    rig.block = 'not-approved';
    rig.missing = [];
    rig.armed = true;
    expect(await publishHoldsFor('seller-1')).toEqual(['clearing-approval', 'subscription']);
  });

  it('names the subscription first while he has NOT given a card — it is his to do', async () => {
    rig.block = 'not-approved';
    rig.missing = [];
    rig.armed = false;
    expect(await publishHoldsFor('seller-1')).toEqual(['subscription', 'clearing-approval']);
  });

  it('holds nothing once the account is approved and the subscription runs', async () => {
    rig.block = null;
    rig.subscribed = true;
    rig.missing = [];
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
