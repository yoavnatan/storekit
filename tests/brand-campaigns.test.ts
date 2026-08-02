/**
 * Platform BRAND campaigns — the owner's own ad spend, against a real Postgres
 * (DB_MIGRATION_PLAN.md §8, moved in the same diff as the boost twin).
 *
 * **The `node:fs` mock this file used to carry is gone, and that is the measurement.** It replaced
 * the module's reads and writes with an in-memory array, so the four `updateBrandCampaign` tests
 * below were the only ones in the suite that could see this module at all — and they were testing
 * an array, not the storage. Stubbing the real I/O to return nothing left 1781 of 1785 tests green.
 * Everything below now runs against the database the application uses.
 *
 * The pure coercion half is unchanged: it never touched storage, and it is where the request-body
 * validation lives (`sanitizeDestination` is an open-redirect guard, `sanitizeImageUrl` an
 * attribute-injection one). Only the budget assertions moved, because the field did.
 */
import { describe, it, expect } from 'vitest';
import {
  parseObjective,
  parsePlatform,
  parseBrandDuration,
  parseBrandBudgetAgorot,
  sanitizeDestination,
  sanitizeImageUrl,
  defaultDestination,
  parseCreateInput,
  createBrandCampaign,
  updateBrandCampaign,
  deleteBrandCampaign,
  getAllBrandCampaigns,
  MAX_BRAND_BUDGET,
  type CreateBrandInput,
} from '../src/lib/brand-campaigns.js';

const SEEDED = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'; // 500 ₪ in the fixture → 50,000 agorot

function input(extra: Partial<CreateBrandInput> = {}): CreateBrandInput {
  return {
    objective: 'buyers', headline: 'h', body: 'b', destinationUrl: '/',
    platform: 'google', monthlyBudgetAgorot: 120_000, ...extra,
  };
}

/** The campaign this test just made, read back through the module's own accessor. */
async function reread(id: string) {
  return (await getAllBrandCampaigns()).find((c) => c.id === id);
}

describe('brand-campaigns input coercion', () => {
  it('objective/platform default safely', () => {
    expect(parseObjective('sellers')).toBe('sellers');
    expect(parseObjective('buyers')).toBe('buyers');
    expect(parseObjective('garbage')).toBe('buyers');
    expect(parsePlatform('meta')).toBe('meta');
    expect(parsePlatform('anything')).toBe('google');
  });

  it('duration accepts only the whitelist', () => {
    expect(parseBrandDuration(7)).toBe(7);
    expect(parseBrandDuration('30')).toBe(30);
    expect(parseBrandDuration(5)).toBeUndefined();
    expect(parseBrandDuration('ongoing')).toBeUndefined();
  });

  it('defaultDestination maps objective → landing path', () => {
    expect(defaultDestination('buyers')).toBe('/');
    expect(defaultDestination('sellers')).toBe('/seller/register');
  });

  it('sanitizeDestination blocks unsafe schemes, allows path + http(s)', () => {
    expect(sanitizeDestination('/stores', 'buyers')).toBe('/stores');
    expect(sanitizeDestination('https://dezabin.co.il/x', 'buyers')).toBe('https://dezabin.co.il/x');
    // Unsafe / non-URL → falls back to the objective default, never passes through.
    expect(sanitizeDestination('javascript:alert(1)', 'buyers')).toBe('/');
    expect(sanitizeDestination('javascript:alert(1)', 'sellers')).toBe('/seller/register');
    expect(sanitizeDestination('  ', 'sellers')).toBe('/seller/register');
    expect(sanitizeDestination(42, 'buyers')).toBe('/');
  });

  it('sanitizeImageUrl accepts only https', () => {
    expect(sanitizeImageUrl('https://res.cloudinary.com/x.png')).toBe('https://res.cloudinary.com/x.png');
    expect(sanitizeImageUrl('http://insecure/x.png')).toBeUndefined();
    expect(sanitizeImageUrl('javascript:x')).toBeUndefined();
    expect(sanitizeImageUrl(123)).toBeUndefined();
  });

  it('turns the owner\'s shekels into integer agorot, and bounds them', () => {
    expect(parseBrandBudgetAgorot(500)).toBe(50_000);
    expect(parseBrandBudgetAgorot('500')).toBe(50_000);
    expect(parseBrandBudgetAgorot(0)).toBe(0);
    expect(parseBrandBudgetAgorot(-1)).toBeNull();
    expect(parseBrandBudgetAgorot('nonsense')).toBeNull();
    // Without a ceiling, `toAgorot(1e30)` is a value the `bigint` column cannot hold — a 500 on
    // the admin page rather than a rejected request.
    expect(parseBrandBudgetAgorot(MAX_BRAND_BUDGET)).toBe(MAX_BRAND_BUDGET * 100);
    expect(parseBrandBudgetAgorot(MAX_BRAND_BUDGET + 1)).toBeNull();
    expect(parseBrandBudgetAgorot(1e30)).toBeNull();
  });

  it('parseCreateInput rejects missing headline/body/budget, coerces the rest', () => {
    expect(parseCreateInput(null)).toBeNull();
    expect(parseCreateInput({ headline: 'x', body: '', monthlyBudget: 5 })).toBeNull();
    expect(parseCreateInput({ headline: 'x', body: 'y', monthlyBudget: -1 })).toBeNull();

    const ok = parseCreateInput({
      objective: 'sellers',
      headline: '  Open a store  ',
      body: 'Join Dezabin',
      monthlyBudget: '500',
      platform: 'meta',
      durationDays: '14',
      destinationUrl: 'javascript:alert(1)', // must be scrubbed to the default
      imageUrl: 'http://insecure',           // must be dropped (not https)
    });
    expect(ok).not.toBeNull();
    expect(ok!.headline).toBe('Open a store');
    // The body says shekels; what leaves this function is agorot, which is why the two fields do
    // not share a name (§7.7 — a unit change under a stable name is a 100× error tsc waves through).
    expect(ok!.monthlyBudgetAgorot).toBe(50_000);
    expect(ok!.platform).toBe('meta');
    expect(ok!.durationDays).toBe(14);
    expect(ok!.destinationUrl).toBe('/seller/register');
    expect(ok!.imageUrl).toBeUndefined();
  });
});

describe('reading what the import wrote', () => {
  it('converts the imported ILS budget to integer agorot', async () => {
    const seeded = await reread(SEEDED);
    expect(seeded!.monthlyBudgetAgorot).toBe(50_000);
    expect(seeded!.headline).toBe('כותרת');
    expect(seeded!.durationDays).toBe(14);
  });

  it('reads an id that is not a uuid as "no such campaign" rather than raising', async () => {
    expect(await updateBrandCampaign('b1', { status: 'paused' })).toBeUndefined();
    expect(await deleteBrandCampaign('b1')).toBe(false);
  });
});

describe('creating and deleting', () => {
  it('round-trips a campaign and reads it back through the accessor', async () => {
    const created = await createBrandCampaign(input({ objective: 'sellers', durationDays: 7 }));
    const read = await reread(created.id);
    expect(read).toEqual(created);
    expect(read!.status).toBe('active');
    expect(read!.monthlyBudgetAgorot).toBe(120_000);
    expect(read!.pausedAt).toBeUndefined();
    expect(read!.imageUrl).toBeUndefined();
    expect(await deleteBrandCampaign(created.id)).toBe(true);
    expect(await reread(created.id)).toBeUndefined();
  });

  it('refuses a negative budget at the column', async () => {
    await expect(createBrandCampaign(input({ monthlyBudgetAgorot: -1 }))).rejects.toThrow();
  });

  it('reports a delete of something that is not there as false, not as success', async () => {
    expect(await deleteBrandCampaign('cccccccc-cccc-4ccc-8ccc-000000000099')).toBe(false);
  });
});

/** A brand campaign is the OWNER'S own ad spend, and it lands in the platform ad-cost figure the
 *  admin Advertising tab reports (admin-ads.ts). That figure is only as honest as the moment the
 *  campaign's metrics froze at — and this module used to record no such moment at all, leaving
 *  ad-metrics.ts#runPeriod to fall back to `updatedAt`. `updatedAt` moves on every edit, so
 *  correcting a paused campaign's budget stretched its run period to the day of the correction
 *  and billed the platform for weeks it never ran. The boost twin has always stamped `pausedAt`
 *  (ad-campaigns.ts#updateCampaign); these hold this half to the same contract, and the twins are
 *  tested in the same shape on purpose — memory `project_brand_boost_twin_drift` is the record of
 *  what happens when one of them is fixed alone. */
describe('updateBrandCampaign — freezing the run period', () => {
  it('stamps the pause moment on the active → paused transition', async () => {
    const c = await createBrandCampaign(input());
    const paused = await updateBrandCampaign(c.id, { status: 'paused' });
    expect(paused!.status).toBe('paused');
    expect(paused!.pausedAt).toBeTruthy();
    expect(paused!.pausedAt).toBe(paused!.updatedAt);
  });

  it('does NOT move the pause moment when a paused campaign is merely re-budgeted', async () => {
    const c = await createBrandCampaign(input());
    const frozenAt = (await updateBrandCampaign(c.id, { status: 'paused' }))!.pausedAt;
    const edited = (await updateBrandCampaign(c.id, { monthlyBudgetAgorot: 80_000 }))!;
    expect(edited.monthlyBudgetAgorot).toBe(80_000);
    // updatedAt moved; the moment the metrics froze at did not. This is the whole bug: without
    // it, runPeriod ends at `edited.updatedAt` and reports spend for the gap in between.
    expect(edited.pausedAt).toBe(frozenAt);
  });

  it('does not re-stamp a campaign that was already paused', async () => {
    const c = await createBrandCampaign(input());
    const frozenAt = (await updateBrandCampaign(c.id, { status: 'paused' }))!.pausedAt;
    expect((await updateBrandCampaign(c.id, { status: 'paused' }))!.pausedAt).toBe(frozenAt);
  });

  it('clears it on resume, so the campaign runs to today again', async () => {
    const c = await createBrandCampaign(input());
    await updateBrandCampaign(c.id, { status: 'paused' });
    const resumed = (await updateBrandCampaign(c.id, { status: 'active' }))!;
    expect(resumed.status).toBe('active');
    expect(resumed.pausedAt).toBeUndefined();
  });

  it('ignores a budget it cannot store rather than writing one the column rejects', async () => {
    const c = await createBrandCampaign(input());
    const edited = (await updateBrandCampaign(c.id, { monthlyBudgetAgorot: -5 }))!;
    expect(edited.monthlyBudgetAgorot).toBe(120_000);
  });
});
