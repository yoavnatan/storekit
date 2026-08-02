/**
 * The platform's own baseline-ad knobs, against a real Postgres (DB_MIGRATION_PLAN.md §8).
 *
 * **This module had ZERO coverage — measured, not assumed.** Stubbing its file I/O to return
 * nothing left all 1785 tests green: no test file existed for it, and its only consumer
 * (`admin-ads.ts`) is fed a settings object by its caller, so `admin-ads.test.ts` never reached the
 * storage either.
 *
 * It also has no table of its own. Two fields with exactly one row is not a table, so the value
 * lives in the keyed `app_settings` jsonb store beside `admin_tab_views`. What that costs is the
 * column type and the CHECK — a jsonb value has neither — and what pays for it is `coerce()`, which
 * every read and every write goes through. So the validation tests below are not belt-and-braces:
 * they ARE the constraint, and before this diff the route accepted any finite number at all, which
 * made `1e30` a valid lifetime budget.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { query } from '../src/lib/db.js';
import {
  getPlatformAdSettings,
  updatePlatformAdSettings,
  parseLifetimeBudgetAgorot,
  MAX_LIFETIME_BUDGET,
} from '../src/lib/platform-ads.js';

/** Every test here writes the one settings row, so each puts it back the way the import left it. */
afterEach(async () => {
  await query(`DELETE FROM app_settings WHERE key = 'platform_ads'`);
});

describe('the shekels an owner types → the agorot the row stores', () => {
  it('converts, and refuses what the column could not hold', () => {
    expect(parseLifetimeBudgetAgorot(2500)).toBe(250_000);
    expect(parseLifetimeBudgetAgorot('2500')).toBe(250_000);
    expect(parseLifetimeBudgetAgorot(0)).toBe(0);
    expect(parseLifetimeBudgetAgorot(-1)).toBeNull();
    // A CLEARED field is "not set", not a rejected request — the form's own input posts `''` when
    // the owner empties it, and 0 is exactly what that means here (`0 = לא הוגדר` on the label).
    expect(parseLifetimeBudgetAgorot('')).toBe(0);
    expect(parseLifetimeBudgetAgorot(undefined)).toBeNull();
    expect(parseLifetimeBudgetAgorot('nonsense')).toBeNull();
    expect(parseLifetimeBudgetAgorot(MAX_LIFETIME_BUDGET)).toBe(MAX_LIFETIME_BUDGET * 100);
    // Rejected rather than clamped: silently booking the ceiling for someone who typed past it is
    // a figure nobody chose.
    expect(parseLifetimeBudgetAgorot(MAX_LIFETIME_BUDGET + 1)).toBeNull();
    expect(parseLifetimeBudgetAgorot(1e30)).toBeNull();
  });
});

describe('reading', () => {
  it('falls back to the defaults when nothing has ever been saved', async () => {
    await query(`DELETE FROM app_settings WHERE key = 'platform_ads'`);
    expect(await getPlatformAdSettings()).toEqual({ baselineStatus: 'active', lifetimeBudgetAgorot: 0 });
  });

  it('reads a stored setting back through the same gate that wrote it', async () => {
    await updatePlatformAdSettings({ baselineStatus: 'paused', lifetimeBudgetAgorot: 250_000 });
    expect(await getPlatformAdSettings()).toEqual({ baselineStatus: 'paused', lifetimeBudgetAgorot: 250_000 });
  });

  it('does not hand a NaN to the admin page when the row holds a shape it did not write', async () => {
    // The row can predate this deploy — the import carried the pre-agorot object, and an older
    // build wrote `lifetimeBudget` in shekels under a different key. Reading through `coerce`
    // means the page renders the default rather than "NaN ₪".
    await query(
      `INSERT INTO app_settings (key, value) VALUES ('platform_ads', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ baselineStatus: 'active', lifetimeBudget: 2500 })],
    );
    expect(await getPlatformAdSettings()).toEqual({ baselineStatus: 'active', lifetimeBudgetAgorot: 0 });
  });

  it('treats an unknown status as active rather than as a third state', async () => {
    await query(
      `INSERT INTO app_settings (key, value) VALUES ('platform_ads', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ baselineStatus: 'nonsense', lifetimeBudgetAgorot: 100 })],
    );
    expect((await getPlatformAdSettings()).baselineStatus).toBe('active');
  });
});

describe('writing', () => {
  it('changes only the key the request carried', async () => {
    await updatePlatformAdSettings({ baselineStatus: 'paused', lifetimeBudgetAgorot: 400_000 });
    // A status toggle must not wipe the budget beside it. The merge is `value || EXCLUDED.value`
    // inside the statement rather than a read-spread-write, so a concurrent change to the other
    // key survives too.
    const after = await updatePlatformAdSettings({ baselineStatus: 'active' });
    expect(after).toEqual({ baselineStatus: 'active', lifetimeBudgetAgorot: 400_000 });
    expect(await getPlatformAdSettings()).toEqual(after);
  });

  it('creates the row on the first save and updates it on the second', async () => {
    expect(await updatePlatformAdSettings({ lifetimeBudgetAgorot: 100_000 }))
      .toEqual({ baselineStatus: 'active', lifetimeBudgetAgorot: 100_000 });
    expect(await updatePlatformAdSettings({ lifetimeBudgetAgorot: 200_000 }))
      .toEqual({ baselineStatus: 'active', lifetimeBudgetAgorot: 200_000 });
    const { rows } = await query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM app_settings WHERE key = 'platform_ads'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('keeps a nonsense budget out of the row instead of storing it', async () => {
    await updatePlatformAdSettings({ lifetimeBudgetAgorot: 300_000 });
    // There is no column CHECK behind a jsonb value, so this is the whole guard: a negative or
    // absurd amount is coerced to "not set" rather than written and read back later as real money.
    expect((await updatePlatformAdSettings({ lifetimeBudgetAgorot: -5 })).lifetimeBudgetAgorot).toBe(0);
    expect((await updatePlatformAdSettings({ lifetimeBudgetAgorot: Number.NaN })).lifetimeBudgetAgorot).toBe(0);
    expect((await updatePlatformAdSettings({ lifetimeBudgetAgorot: 1e30 })).lifetimeBudgetAgorot)
      .toBe(MAX_LIFETIME_BUDGET * 100);
  });

  it('leaves the row alone when the request carried nothing valid', async () => {
    await updatePlatformAdSettings({ baselineStatus: 'paused', lifetimeBudgetAgorot: 500_000 });
    const after = await updatePlatformAdSettings({});
    expect(after).toEqual({ baselineStatus: 'paused', lifetimeBudgetAgorot: 500_000 });
  });
});
