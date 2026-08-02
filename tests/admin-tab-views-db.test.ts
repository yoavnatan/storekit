/**
 * The admin's "last opened" boundaries against a real Postgres (DB_MIGRATION_PLAN.md §8).
 *
 * **Zero coverage before this — measured (2026-08-02).** Stubbing the module's file I/O to return
 * nothing left the suite at 1825 of 1825; `tests/admin-tab-views.test.ts` only ever exercised
 * `countSince` over hand-built arrays.
 *
 * Two things are being held still here. The value lives in the keyed `app_settings` jsonb store
 * rather than a table of its own, so **`coerce` is the column type** — there is no CHECK and no
 * `timestamptz` behind it, and the import copies whatever the file held straight through (the
 * fixture literally carries `{"orders": 12}`). And the write **merges inside the statement**, so
 * one tab's boundary cannot wipe the three beside it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '../src/lib/db.js';
import {
  getAllLastViewedAt,
  recordTabView,
  countSince,
  isTrackedAdminTab,
  TRACKED_ADMIN_TABS,
} from '../src/lib/admin-tab-views.js';

const KEY = `admin_tab_views`;

async function storeRaw(value: unknown): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [KEY, JSON.stringify(value)],
  );
}

async function readRaw(): Promise<Record<string, unknown>> {
  const { rows } = await query<{ value: Record<string, unknown> | string }>(
    'SELECT value FROM app_settings WHERE key = $1', [KEY],
  );
  const value = rows[0]?.value;
  return typeof value === 'string' ? JSON.parse(value) : (value ?? {});
}

beforeEach(async () => { await query('DELETE FROM app_settings WHERE key = $1', [KEY]); });
afterEach(async () => { await query('DELETE FROM app_settings WHERE key = $1', [KEY]); });

describe('reading all four boundaries', () => {
  it('returns exactly the tracked tabs and nothing else', async () => {
    const views = await getAllLastViewedAt();
    expect(Object.keys(views).sort()).toEqual([...TRACKED_ADMIN_TABS].sort());
  });

  it('defaults an unrecorded tab to now, not to the epoch', async () => {
    // Otherwise every seller/store/order that already existed the day this shipped would wear a
    // "new" chip the first time the dashboard loads.
    const before = Date.now();
    const views = await getAllLastViewedAt();
    for (const tab of TRACKED_ADMIN_TABS) {
      expect(Date.parse(views[tab])).toBeGreaterThanOrEqual(before - 1000);
    }
  });

  it('reads back what was recorded', async () => {
    await recordTabView('orders', '2026-03-01T09:00:00.000Z');
    expect((await getAllLastViewedAt()).orders).toBe('2026-03-01T09:00:00.000Z');
  });

  it('treats a stored value that is not a timestamp as unrecorded', async () => {
    // jsonb has no column type, and this is not hypothetical: the fixture the import reads holds
    // `{"orders": 12}`. Handed through, `createdAt > 12` compares a string against a number — false
    // for every row, i.e. a badge silently stuck at zero forever.
    await storeRaw({ orders: 12, stores: 'not a date', sellers: null, alerts: { nested: true } });
    const views = await getAllLastViewedAt();
    const now = Date.now();
    for (const tab of TRACKED_ADMIN_TABS) {
      expect(Number.isNaN(Date.parse(views[tab]))).toBe(false);
      expect(Date.parse(views[tab])).toBeGreaterThan(now - 5000);
    }
  });

  it('survives a row whose value is not an object at all', async () => {
    await storeRaw('a bare string');
    const views = await getAllLastViewedAt();
    expect(Object.keys(views).sort()).toEqual([...TRACKED_ADMIN_TABS].sort());
  });
});

describe('recording a tab view', () => {
  it('changes only the tab it was given', async () => {
    // The merge is `value || EXCLUDED.value` inside the statement rather than a read-spread-write.
    // The client posts a view on every tab switch, so two of these are one click apart.
    await recordTabView('sellers', '2026-01-01T00:00:00.000Z');
    await recordTabView('orders', '2026-02-02T00:00:00.000Z');
    const views = await getAllLastViewedAt();
    expect(views.sellers).toBe('2026-01-01T00:00:00.000Z');
    expect(views.orders).toBe('2026-02-02T00:00:00.000Z');
    expect(await readRaw()).toEqual({
      sellers: '2026-01-01T00:00:00.000Z',
      orders: '2026-02-02T00:00:00.000Z',
    });
  });

  it('creates the row on the first record and keeps exactly one afterwards', async () => {
    await recordTabView('alerts');
    await recordTabView('alerts');
    await recordTabView('stores');
    const { rows } = await query<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM app_settings WHERE key = $1', [KEY],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('does not sit beside the other settings key', async () => {
    // `platform_ads` shares this table. A write that replaced the row instead of its own key would
    // take the platform's ad budget with it.
    await query(
      `INSERT INTO app_settings (key, value) VALUES ('platform_ads', '{"lifetimeBudgetAgorot":123}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    await recordTabView('orders');
    const { rows } = await query<{ value: Record<string, unknown> | string }>(
      `SELECT value FROM app_settings WHERE key = 'platform_ads'`,
    );
    const ads = typeof rows[0]!.value === 'string' ? JSON.parse(rows[0]!.value as string) : rows[0]!.value;
    expect(ads).toEqual({ lifetimeBudgetAgorot: 123 });
    await query(`DELETE FROM app_settings WHERE key = 'platform_ads'`);
  });

  it('stores a real timestamp when handed something that is not one', async () => {
    await recordTabView('stores', 'yesterday-ish');
    const stored = (await readRaw()).stores;
    expect(typeof stored).toBe('string');
    expect(Number.isNaN(Date.parse(stored as string))).toBe(false);
  });

  it('writes nothing for a tab outside the tracked list', async () => {
    await recordTabView('messages' as 'orders');
    expect(await readRaw()).toEqual({});
  });
});

describe('the tracked-tab list is single-sourced', () => {
  it('accepts the four and refuses everything else', () => {
    // The admin page and the POST route each kept their own copy of this list before the move.
    for (const tab of TRACKED_ADMIN_TABS) expect(isTrackedAdminTab(tab)).toBe(true);
    expect(isTrackedAdminTab('messages')).toBe(false);
    expect(isTrackedAdminTab('')).toBe(false);
    expect(isTrackedAdminTab(undefined)).toBe(false);
    expect(isTrackedAdminTab(12)).toBe(false);
  });

  it('is not spelled out anywhere else in src/', () => {
    // The guard-test pattern of safe-redirect.ts / email-address.ts, and it earned itself
    // immediately: it found a THIRD copy nobody had looked for, in `src/scripts/admin/tab-nav.ts`
    // — the browser code that decides which tab switches get reported. That copy is why the list
    // sits in `lib/admin-tabs.ts` (no imports at all) rather than in `admin-tab-views.ts`, which
    // pulls in the database and so can never be bundled for a page.
    const offenders: string[] = [];
    const literal = /\[\s*'sellers'\s*,\s*'stores'\s*,\s*'orders'\s*,\s*'alerts'\s*\]/;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|astro)$/.test(entry.name)) continue;
        if (full.endsWith(path.join('lib', 'admin-tabs.ts'))) continue; // the one source
        if (literal.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(process.cwd(), full));
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect(offenders, `import TRACKED_ADMIN_TABS instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('countSince', () => {
  it('is unchanged by the move — still pure', () => {
    const items = [{ createdAt: '2026-01-01T00:00:00.000Z' }, { createdAt: '2026-01-10T00:00:00.000Z' }];
    expect(countSince(items, '2026-01-04T00:00:00.000Z', (i) => i.createdAt)).toBe(1);
  });
});
