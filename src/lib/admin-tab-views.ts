import { firstRow, query } from './db.js';
import { TRACKED_ADMIN_TABS, isTrackedAdminTab, type TrackedAdminTab } from './admin-tabs.js';

/**
 * When the admin last opened each list tab — the boundary behind every "(N) new since last opened"
 * badge and every "חדש" chip on the rows themselves.
 *
 * **Moved to Postgres (DB_MIGRATION_PLAN.md §8, the last of "the rest").** Like `platform-ads.ts`
 * it has no table of its own: four timestamps in one object is not a table, so it lives in the
 * keyed `app_settings` jsonb store beside it. That costs the column type and the CHECK — a jsonb
 * value has neither — and `coerce()` below is what pays for it. That is not theoretical here: the
 * import copies the file through as-is, and the test fixture holds `{"orders": 12}`, a number where
 * a timestamp belongs.
 *
 * **The read is ONE query for all four tabs.** The naive translation of the caller
 * (`admin/index.astro` looped over the tab list) is four round trips for a single jsonb row.
 */

// The tab list itself lives in `admin-tabs.ts`, which depends on nothing — the browser code in
// `src/scripts/admin/tab-nav.ts` needs the same list and cannot import this file, because this file
// imports the database. Re-exported so existing importers keep one place to reach for.
export { TRACKED_ADMIN_TABS, isTrackedAdminTab, type TrackedAdminTab };

export type TabViews = Record<TrackedAdminTab, string>;

const SETTINGS_KEY = 'admin_tab_views';

/** An ISO timestamp, or nothing. `Date.parse` rather than a shape regex because the value is read
 *  back out of jsonb, where it may be a number, an object, or a string from another era. */
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * A tab that was never recorded defaults to "now" rather than the epoch —
 * otherwise every seller/store/order/error that already existed the day
 * this feature shipped would count as "new" the first time the dashboard
 * loads. The count only becomes meaningful once recordTabView has actually
 * run for that tab (i.e. the admin opened it at least once).
 *
 * A stored value that is not a timestamp gets the same treatment as a missing one: "now" makes the
 * badge say nothing, while a number would make `createdAt > lastViewedAt` compare a string against
 * a number — always false, i.e. a badge silently stuck at zero forever.
 */
function coerce(raw: unknown): TabViews {
  const stored = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const now = new Date().toISOString();
  const views = {} as TabViews;
  for (const tab of TRACKED_ADMIN_TABS) {
    const value = stored[tab];
    views[tab] = isTimestamp(value) ? new Date(value).toISOString() : now;
  }
  return views;
}

/** All four boundaries in one read — see the module note on why this is not per-tab. */
export async function getAllLastViewedAt(): Promise<TabViews> {
  const row = await firstRow<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [SETTINGS_KEY],
  );
  // `pg` parses `jsonb` for us; a driver that hands back the raw text must not become a 500.
  const value = typeof row?.value === 'string' ? safeParse(row.value) : row?.value;
  return coerce(value);
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Record that the admin just opened one tab.
 *
 * `value || EXCLUDED.value` is jsonb concatenation, which overwrites only the key on the right —
 * so opening "orders" cannot wipe the three boundaries beside it. Reading the object, spreading it
 * in JS and writing it back would lose a concurrent write to another key (same reasoning as
 * `platform-ads.ts`), and here that is not hypothetical: the client posts a tab view on every tab
 * switch, so two are one click apart.
 */
export async function recordTabView(tab: TrackedAdminTab, at: string = new Date().toISOString()): Promise<void> {
  if (!isTrackedAdminTab(tab)) return;
  const stamp = isTimestamp(at) ? new Date(at).toISOString() : new Date().toISOString();
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = app_settings.value || EXCLUDED.value, updated_at = now()`,
    [SETTINGS_KEY, JSON.stringify({ [tab]: stamp })],
  );
}

export function countSince<T>(items: T[], lastViewedAt: string, getCreatedAt: (item: T) => string): number {
  return items.filter((item) => getCreatedAt(item) > lastViewedAt).length;
}
