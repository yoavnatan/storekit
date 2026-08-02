import { AD_PLATFORM_MARGIN_PERCENT } from '../src/lib/pricing.js';
import { describe, it, expect } from 'vitest';
import { baselineImpressionsInRange, campaignStatsInRange, campaignLifetimeStats, campaignRunPeriod, brandStatsInRange } from '../src/lib/ad-metrics.js';
import type { AdCampaign } from '../src/lib/ad-campaigns.js';
import type { BrandCampaign } from '../src/lib/brand-campaigns.js';

function campaign(over: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id: 'c1', storeId: 's1', storeSlug: 's1', scope: 'store', platform: 'google',
    monthlyBudgetAgorot: 30000, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
function brand(over: Partial<BrandCampaign> = {}): BrandCampaign {
  return {
    id: 'b1', objective: 'buyers', headline: 'x', body: 'y', destinationUrl: '/', platform: 'google',
    monthlyBudgetAgorot: 60000, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('ad-metrics (range-aware mock)', () => {
  it('baseline is deterministic and scales with range length', () => {
    const a = baselineImpressionsInRange('s1', '2026-07-14', '2026-07-20'); // 7 days
    const b = baselineImpressionsInRange('s1', '2026-07-14', '2026-07-20');
    const long = baselineImpressionsInRange('s1', '2026-06-21', '2026-07-20'); // 30 days
    expect(a).toBe(b);                 // deterministic
    expect(long).toBeGreaterThan(a);   // more days → more impressions
  });

  it('campaign: created after range → zero, active → positive, deterministic', () => {
    // Campaign created 2026-08 but range is in July → not yet live → zero.
    expect(campaignStatsInRange(campaign({ createdAt: '2026-08-01T00:00:00.000Z' }), '2026-07-14', '2026-07-20').impressions).toBe(0);
    const live = campaignStatsInRange(campaign(), '2026-07-14', '2026-07-20');
    expect(live.impressions).toBeGreaterThan(0);
    expect(live.spend).toBeGreaterThan(0);
    expect(campaignStatsInRange(campaign(), '2026-07-14', '2026-07-20')).toEqual(live); // deterministic
  });

  it('campaign spend counts only the days it was live within the range', () => {
    // Created mid-range (2026-07-18) → only 3 of the 7 range-days count.
    const partial = campaignStatsInRange(campaign({ createdAt: '2026-07-18T00:00:00.000Z' }), '2026-07-14', '2026-07-20');
    const full = campaignStatsInRange(campaign(), '2026-07-14', '2026-07-20');
    expect(partial.spend).toBeLessThan(full.spend);
    expect(partial.spend).toBeGreaterThan(0);
  });

  it('pausing FREEZES accrued metrics, it does NOT erase them (item 1)', () => {
    // Active 2026-07-01 → paused 2026-07-10.
    const paused = campaign({ status: 'paused', createdAt: '2026-07-01T00:00:00.000Z', pausedAt: '2026-07-10T00:00:00.000Z' });
    // A window INSIDE the active period still reports the days it ran — not zero.
    expect(campaignStatsInRange(paused, '2026-07-05', '2026-07-08').impressions).toBeGreaterThan(0);
    // A window entirely AFTER the pause reports zero (it wasn't running then).
    expect(campaignStatsInRange(paused, '2026-07-12', '2026-07-15').impressions).toBe(0);
    // Lifetime = exactly the active window 07-01→07-10, frozen at the pause.
    const lifetime = campaignLifetimeStats(paused, new Date(2026, 6, 20));
    const activeEquivalent = campaignStatsInRange(campaign({ createdAt: '2026-07-01T00:00:00.000Z' }), '2026-07-01', '2026-07-10');
    expect(lifetime).toEqual(activeEquivalent);
    expect(campaignRunPeriod(paused, new Date(2026, 6, 20))).toMatchObject({ start: '2026-07-01', end: '2026-07-10', days: 10 });
  });

  it('lifetime respects a fixed duration cap', () => {
    const c = campaign({ createdAt: '2026-07-01T00:00:00.000Z', durationDays: 7 });
    // Runs 07-01..07-07 (7 days) regardless of how long ago that was.
    expect(campaignRunPeriod(c, new Date(2026, 6, 20))).toMatchObject({ start: '2026-07-01', end: '2026-07-07', days: 7 });
    const capped = campaignLifetimeStats(c, new Date(2026, 6, 20));
    // Compared against THE SAME campaign windowed to its exact run period, so the only thing
    // under test is that lifetime stops at day 7. It used to compare against a campaign built
    // WITHOUT durationDays, which quietly made it a test of the daily rate as well — and those
    // two campaigns no longer share one: a fixed-duration budget is a TOTAL, an ongoing one is
    // monthly (ad-metrics.ts#dailyBudget). Same-campaign is what the claim was always about.
    expect(capped).toEqual(campaignStatsInRange(c, '2026-07-01', '2026-07-07'));
    // And it stays capped: a window running well past the end adds nothing.
    expect(campaignStatsInRange(c, '2026-07-01', '2026-07-31')).toEqual(capped);
  });

  it('a fixed-duration budget is a TOTAL, and a total is a ceiling — not a charge', () => {
    // Two claims, and both have to hold. PACING: the seller is shown "תקרת תקציב לקמפיין" on a
    // 7/14/30-day boost, so a boost that runs its full course is paced against the whole cap, not
    // against a thirty-day slice of it (that reported a fifth of what he capped). DELIVERY: the
    // cap is still only a ceiling — Google and Meta charge for what the auction delivered, which
    // is why "משלמים רק על הוצאה בפועל" is on the form, so the figure lands NEAR the cap and
    // under it. Pacing without delivery would quietly turn the ceiling into a commitment.
    const fixed = campaign({ createdAt: '2026-07-01T00:00:00.000Z', durationDays: 7, monthlyBudgetAgorot: 30000 });
    const fixedSpend = campaignLifetimeStats(fixed, new Date(2026, 6, 20)).spend;
    expect(fixedSpend).toBeLessThan(300);
    expect(fixedSpend).toBeGreaterThan(300 * 0.8);

    // The ongoing reading of the same number: per month, so a week is 7/30 of that month's spend.
    const ongoing = campaign({ createdAt: '2026-07-01T00:00:00.000Z', monthlyBudgetAgorot: 30000 });
    const ongoingMonth = campaignStatsInRange(ongoing, '2026-07-01', '2026-07-30').spend;
    expect(ongoingMonth).toBeLessThan(300);
    expect(campaignStatsInRange(ongoing, '2026-07-01', '2026-07-07').spend).toBeCloseTo(ongoingMonth * (7 / 30), 1);

    // Brand campaigns are the platform's own ad cost and read the same way.
    const brandSpend = brandStatsInRange(brand({ durationDays: 14, monthlyBudgetAgorot: 140000 }), '2026-01-01', '2026-01-14').spend;
    expect(brandSpend).toBeLessThan(1400);
    expect(brandSpend).toBeGreaterThan(1400 * 0.8);
  });

  it('brand: conversions never exceed clicks; paused → zero', () => {
    const s = brandStatsInRange(brand(), '2026-07-14', '2026-07-20');
    expect(s.conversions).toBeLessThanOrEqual(s.clicks);
    expect(brandStatsInRange(brand({ status: 'paused' }), '2026-07-14', '2026-07-20').impressions).toBe(0);
  });
});

/** The budget field means two different things depending on the duration the seller picked, and
 *  the form says so ("monthly cap" vs "campaign cap"). The spend figures have to agree with it —
 *  a seller who caps a week at 500₪ and is shown 117₪ after that week is reading a number that
 *  contradicts what he was asked. */
describe('spend follows the campaign\'s own period, not always a month', () => {
  const base = {
    id: 'c-budget', storeId: 's1', storeSlug: 's', scope: 'store' as const, platform: 'both' as const,
    monthlyBudgetAgorot: 50000, status: 'active' as const,
    createdAt: '2026-06-01T09:00:00.000Z', updatedAt: '2026-06-01T09:00:00.000Z',
  };

  // A cap is a ceiling, not a commitment: the auction decides how much of it is actually
  // delivered. So a fully-run campaign lands NEAR the cap — never on it, never a fifth of it.
  it('a fixed-duration campaign that runs to the end approaches its cap without reaching it', () => {
    const week = { ...base, durationDays: 7 as const };
    const spend = campaignLifetimeStats(week, new Date('2026-07-01T00:00:00Z')).spend;
    expect(spend).toBeLessThan(500);
    expect(spend).toBeGreaterThan(500 * 0.8);
  });

  it('and a proportional slice of it part-way through', () => {
    const week = { ...base, durationDays: 7 as const };
    const full = campaignLifetimeStats(week, new Date('2026-07-01T00:00:00Z')).spend;
    // Days 1-3 of the seven: three sevenths of whatever the whole week delivered.
    const partial = campaignStatsInRange(week, '2026-06-01', '2026-06-03');
    expect(partial.spend).toBeCloseTo(full * (3 / 7), 1);
  });

  // The ceiling invariant the cap word promises: whatever window is asked for, a fixed-duration
  // campaign can never report more spend than the total it was capped at.
  it('never reports more than the cap, over any window', () => {
    const week = { ...base, durationDays: 7 as const };
    for (const [from, to] of [['2026-05-01', '2026-12-31'], ['2026-06-01', '2026-06-30'], ['2026-06-03', '2026-06-05']]) {
      expect(campaignStatsInRange(week, from!, to!).spend).toBeLessThanOrEqual(500);
    }
    expect(campaignLifetimeStats(week, new Date('2027-01-01T00:00:00Z')).spend).toBeLessThanOrEqual(500);
  });

  // The pacing half, independent of delivery: an ongoing 500₪ cap is a MONTHLY one, so a month
  // gets a full cap's worth of pacing where a week gets a quarter of it.
  it('paces an ongoing campaign monthly, not over a week', () => {
    const ongoing = { ...base };
    const month = campaignStatsInRange(ongoing, '2026-06-01', '2026-06-30');
    const week = campaignStatsInRange(ongoing, '2026-06-01', '2026-06-07');
    expect(month.spend).toBeLessThan(500);
    expect(month.spend).toBeGreaterThan(500 * 0.8);
    expect(week.spend).toBeCloseTo(month.spend * (7 / 30), 1);
  });
});

/** Two figures on one card can answer the same question, and when they do they have to agree.
 *  ROAS is "revenue ÷ spend"; conversions are the sales that revenue comes from. Seeding them
 *  independently let a card claim a x4.96 return beside zero sales. */
describe('ROAS is the sales, not a mood', () => {
  const c = {
    id: 'c-roas', storeId: 's1', storeSlug: 's', scope: 'store' as const, platform: 'both' as const,
    monthlyBudgetAgorot: 30000, status: 'active' as const,
    createdAt: '2026-06-01T09:00:00.000Z', updatedAt: '2026-06-01T09:00:00.000Z',
  };

  it('is zero exactly when there were no sales', () => {
    // A single day of a tiny budget buys too little traffic to convert.
    const tiny = campaignStatsInRange({ ...c, id: 'c-tiny', monthlyBudgetAgorot: 5000 }, '2026-06-01', '2026-06-01');
    expect(tiny.conversions).toBe(0);
    expect(tiny.roas).toBe(0);
  });

  it('grows with the sales it claims to come from, at a stable efficiency', () => {
    const short = campaignStatsInRange(c, '2026-06-01', '2026-06-05');
    const long = campaignStatsInRange(c, '2026-06-01', '2026-06-30');
    expect(long.conversions).toBeGreaterThan(short.conversions);
    // ROAS is a RATIO, so a longer window buys more of everything and lands in the same
    // neighbourhood rather than climbing — the wobble is conversions being whole orders
    // (Math.round), which bites hardest on the shortest window. Asserting monotonic growth here
    // would have been asserting the rounding, not the model.
    // ±25% of each other is the band whole-order rounding can move a 5-day window inside.
    expect(long.roas).toBeGreaterThan(short.roas * 0.75);
    expect(long.roas).toBeLessThan(short.roas * 1.25);
  });

  it('reads back as revenue ÷ spend at a plausible basket value', () => {
    const s = campaignStatsInRange(c, '2026-06-01', '2026-06-30');
    const impliedBasket = (s.roas * s.spend) / s.conversions;
    expect(impliedBasket).toBeGreaterThan(80);
    expect(impliedBasket).toBeLessThan(280);
  });
});

/** The management fee comes OUT of the budget (owner's decision, 2026-07-30): a 500₪ cap is a
 *  ceiling on what the SELLER PAYS, and the advertising it buys is that minus the fee — not
 *  500₪ of ads with a bill on top. Two figures travel together for it, and the gap between them
 *  is the platform's only income here. */
describe('the fee comes out of the budget', () => {
  const c = {
    id: 'c-fee', storeId: 's1', storeSlug: 's', scope: 'store' as const, platform: 'both' as const,
    monthlyBudgetAgorot: 100000, status: 'active' as const, durationDays: 30 as const,
    createdAt: '2026-06-01T09:00:00.000Z', updatedAt: '2026-06-01T09:00:00.000Z',
  };
  const stats = campaignLifetimeStats(c, new Date('2026-07-15T00:00:00Z'));

  it('never charges the seller more than his cap', () => {
    expect(stats.spend).toBeLessThanOrEqual(1000);
  });

  it('buys less advertising than the seller paid, by exactly the platform fee', () => {
    expect(stats.adSpend).toBeLessThan(stats.spend);
    const impliedFeePct = ((stats.spend - stats.adSpend) / stats.adSpend) * 100;
    expect(impliedFeePct).toBeCloseTo(AD_PLATFORM_MARGIN_PERCENT, 1);
  });

  it('prices the exposure off the advertising money, not off the charge', () => {
    // cpm is bounded (12–32 ₪ per 1000), so impressions must sit in the band the AD money buys —
    // deriving them from the charge would show exposure the fee never paid for.
    expect(stats.impressions).toBeLessThanOrEqual((stats.adSpend / 12) * 1000);
    expect(stats.impressions).toBeGreaterThanOrEqual((stats.adSpend / 32) * 1000);
  });

  it('leaves the platform its own ads fee-free — it does not bill itself', () => {
    const b = brandStatsInRange(brand({ durationDays: 14, monthlyBudgetAgorot: 140000 }), '2026-01-01', '2026-01-14');
    expect(b.adSpend).toBe(b.spend);
  });
});
