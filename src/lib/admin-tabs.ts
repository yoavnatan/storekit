/**
 * Which admin tabs carry a "(N) new since last opened" badge — the list itself, and nothing else.
 *
 * **Why this is its own file.** The rule had THREE copies before 2026-08-02: the admin page, the
 * `/api/admin/tab-view` route, and `src/scripts/admin/tab-nav.ts` — the browser code that decides
 * which tab switches are worth reporting. Three copies of one list is how a fifth tab gets a badge
 * the server will not clear, or a POST the route answers 400 to.
 *
 * The obvious home, `admin-tab-views.ts`, cannot serve the client: it imports `db.ts`, which imports
 * `pg`. So the list lives here, where it depends on nothing at all and both sides may import it.
 * `tests/admin-tab-views-db.test.ts` greps `src/` and fails if a fourth copy appears.
 *
 * Messages is deliberately absent — it has an exact per-message read flag (`admin-messages.ts`'s
 * `readByAdmin`), which is a finer signal than one timestamp per tab.
 */
export type TrackedAdminTab = 'sellers' | 'stores' | 'orders' | 'alerts';

export const TRACKED_ADMIN_TABS: readonly TrackedAdminTab[] = ['sellers', 'stores', 'orders', 'alerts'];

export function isTrackedAdminTab(value: unknown): value is TrackedAdminTab {
  return typeof value === 'string' && (TRACKED_ADMIN_TABS as readonly string[]).includes(value);
}
