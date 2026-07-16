import fs from 'node:fs';
import path from 'node:path';

const VIEWS_PATH = path.join(process.cwd(), 'data/admin-tab-views.json');

// The 4 list tabs whose "(N) new since last opened" badge (CURRENT_TASK.md →
// סשן ב׳) is driven by a generic createdAt-vs-last-viewed comparison.
// Messages isn't here — it already has an exact per-message read flag
// (admin-messages.ts's readByAdmin), a more precise signal than a single
// per-tab timestamp, so it keeps using that instead.
export type TrackedAdminTab = 'sellers' | 'stores' | 'orders' | 'alerts';

function readViews(): Partial<Record<TrackedAdminTab, string>> {
  try { return JSON.parse(fs.readFileSync(VIEWS_PATH, 'utf8')); }
  catch { return {}; }
}

function writeViews(views: Partial<Record<TrackedAdminTab, string>>): void {
  fs.writeFileSync(VIEWS_PATH, JSON.stringify(views, null, 2));
}

// A tab that was never recorded defaults to "now" rather than the epoch —
// otherwise every seller/store/order/error that already existed the day
// this feature shipped would count as "new" the first time the dashboard
// loads. The count only becomes meaningful once recordTabView has actually
// run for that tab (i.e. the admin opened it at least once).
export function getLastViewedAt(tab: TrackedAdminTab): string {
  return readViews()[tab] ?? new Date().toISOString();
}

export function recordTabView(tab: TrackedAdminTab, at: string = new Date().toISOString()): void {
  const views = readViews();
  views[tab] = at;
  writeViews(views);
}

export function countSince<T>(items: T[], lastViewedAt: string, getCreatedAt: (item: T) => string): number {
  return items.filter((item) => getCreatedAt(item) > lastViewedAt).length;
}
