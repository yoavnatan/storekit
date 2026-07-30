import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  parseObjective,
  parsePlatform,
  parseBrandDuration,
  sanitizeDestination,
  sanitizeImageUrl,
  defaultDestination,
  parseCreateInput,
  updateBrandCampaign,
  type BrandCampaign,
} from '../src/lib/brand-campaigns.js';

// The journal, in memory. Declared through vi.hoisted because the vi.mock factory below is
// hoisted above every import — a plain const here would not exist yet when brand-campaigns.js
// pulls in node:fs at module load.
const { STORE } = vi.hoisted(() => ({ STORE: [] as BrandCampaign[] }));

vi.mock('node:fs', () => ({
  default: {
    readFileSync: () => JSON.stringify(STORE),
    writeFileSync: (_p: string, data: string) => { STORE.length = 0; STORE.push(...JSON.parse(data) as BrandCampaign[]); },
  },
}));

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
    expect(ok!.monthlyBudget).toBe(500);
    expect(ok!.platform).toBe('meta');
    expect(ok!.durationDays).toBe(14);
    expect(ok!.destinationUrl).toBe('/seller/register');
    expect(ok!.imageUrl).toBeUndefined();
  });
});

/** A brand campaign is the OWNER'S own ad spend, and it lands in the platform ad-cost figure the
 *  admin Advertising tab reports (admin-ads.ts). That figure is only as honest as the moment the
 *  campaign's metrics froze at — and this module used to record no such moment at all, leaving
 *  ad-metrics.ts#runPeriod to fall back to `updatedAt`. `updatedAt` moves on every edit, so
 *  correcting a paused campaign's budget stretched its run period to the day of the correction
 *  and billed the platform for weeks it never ran. The boost twin has always stamped `pausedAt`
 *  (ad-campaigns.ts#updateCampaign); these hold this half to the same contract. */
describe('updateBrandCampaign — freezing the run period', () => {
  beforeEach(() => {
    STORE.length = 0;
    STORE.push({
      id: 'b1', objective: 'buyers', headline: 'h', body: 'b', destinationUrl: '/',
      platform: 'google', monthlyBudget: 1200, status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('stamps the pause moment on the active → paused transition', () => {
    const paused = updateBrandCampaign('b1', { status: 'paused' });
    expect(paused!.status).toBe('paused');
    expect(paused!.pausedAt).toBeTruthy();
    expect(paused!.pausedAt).toBe(paused!.updatedAt);
  });

  it('does NOT move the pause moment when a paused campaign is merely re-budgeted', () => {
    const frozenAt = updateBrandCampaign('b1', { status: 'paused' })!.pausedAt;
    const edited = updateBrandCampaign('b1', { monthlyBudget: 800 })!;
    expect(edited.monthlyBudget).toBe(800);
    // updatedAt moved; the moment the metrics froze at did not. This is the whole bug: without
    // it, runPeriod ends at `edited.updatedAt` and reports spend for the gap in between.
    expect(edited.pausedAt).toBe(frozenAt);
  });

  it('does not re-stamp a campaign that was already paused', () => {
    const frozenAt = updateBrandCampaign('b1', { status: 'paused' })!.pausedAt;
    expect(updateBrandCampaign('b1', { status: 'paused' })!.pausedAt).toBe(frozenAt);
  });

  it('clears it on resume, so the campaign runs to today again', () => {
    updateBrandCampaign('b1', { status: 'paused' });
    const resumed = updateBrandCampaign('b1', { status: 'active' })!;
    expect(resumed.status).toBe('active');
    expect(resumed.pausedAt).toBeUndefined();
  });
});
