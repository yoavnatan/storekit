/**
 * Launch mode — how the platform presents itself before it has a real catalog.
 *
 * The cold-start problem: a multi-vendor mall with 0 (or 2) stores rendered its
 * discovery UI as a grey "nothing here" icon, which reads as broken. Decision
 * (2026-07-28): never fabricate demo stores, and equally never *announce* the
 * emptiness — no "the first stores", no "coming soon", no waitlist. The page
 * keeps its normal shape and normal titles; the slots a store would occupy are
 * filled with soft product line-art placeholder cards (placeholder-art.ts) that
 * are simply an invitation to open a store. Amorphous on purpose: the art is an
 * eclectic mix and no card is labelled with a category, because the platform
 * doesn't decide which field a seller belongs to.
 *
 * Two thresholds, both counted in stores that are visible AND have at least one
 * visible product (the set the homepage feed is built from — a store nobody can
 * buy from doesn't fill the mall):
 *   < LAUNCH_MODE_MAX_STORES  → the Discover tab is one shelf of real stores
 *                               padded with placeholders (category shelves and
 *                               the spotlight are skipped — too thin to repeat).
 *   < SHELF_INVITE_MAX_STORES → normal site, one placeholder closes the
 *                               discovery shelf and the directory grid.
 *
 * Pure module — no fs, no Astro. Covered by tests/launch-mode.test.ts.
 */

/** Below this many live stores the homepage's discovery surface is placeholder-padded. */
export const LAUNCH_MODE_MAX_STORES = 5;

/** Below this many live stores shelves/grids still end with one placeholder card. */
export const SHELF_INVITE_MAX_STORES = 10;

/** Slots a launch-mode shelf fills (real stores first, placeholders after).
 *  Even, and deliberately NOT tied to the store threshold: the shelf becomes a
 *  2-column grid under 640px (`fillMobile`), where an odd count leaves the last
 *  card sitting alone in its own row. */
export const LAUNCH_SLOTS = 6;

/** Slots the /stores grid fills in launch mode — a multiple of 2/3/4 so no
 *  column count leaves a single orphan card on the last row. */
export const LAUNCH_GRID_SLOTS = 12;

export function isLaunchMode(liveStoreCount: number): boolean {
  return liveStoreCount < LAUNCH_MODE_MAX_STORES;
}

export function showShelfInvite(liveStoreCount: number): boolean {
  return liveStoreCount > 0 && liveStoreCount < SHELF_INVITE_MAX_STORES;
}

/** How many placeholders pad a row that already holds `liveStoreCount` real cards. */
export function launchInviteCount(liveStoreCount: number, slots: number = LAUNCH_SLOTS): number {
  return Math.max(0, slots - liveStoreCount);
}

/** A launch-mode shelf ALWAYS ends with at least this many "your store here" cards.
 *  Without it the row silently loses its invitation the moment stores fill every
 *  slot — 3 real + 3 showcase stores is exactly 6, so the one card that recruits
 *  sellers vanished at the point launch mode was still on (user, 2026-07-28). */
export const MIN_SHELF_INVITES = 1;

/** …and keeps at least this many showcase stores, so a seller landing mid-launch
 *  still has a finished store to open. Ignored when none are seeded.
 *
 *  It is also the CAP once real stores exist: three showcase stores plus two real
 *  ones is six cards, and the shelf scrolls horizontally at about four and a half
 *  — which pushed the placeholder off-screen entirely, i.e. exactly the card the
 *  minimum above exists to protect. One showcase store is enough to make the point
 *  once the mall has anything real in it. */
export const MIN_SHELF_DEMO = 1;

export interface LaunchShelfPlan<T> {
  /** Real stores first, then showcase stores — placeholders come after both. */
  stores: T[];
  invites: number;
}

/**
 * Decides what a launch-mode shelf holds: real stores, showcase stores and
 * placeholder cards, in that order, within `slots`.
 *
 * The guarantee is that the row is never all-stores and never all-placeholders
 * while launch mode is on — it always shows the mall filling up AND the open slot
 * next to it, because that pairing is the actual message of the page. Real stores
 * outrank showcase ones for the remaining room: the platform's own stores are
 * filler, and the moment there are real ones to show they should be what's shown.
 *
 * Pure — covered by tests/launch-mode.test.ts.
 */
export function planLaunchShelf<T>(
  real: readonly T[],
  demo: readonly T[],
  slots: number = LAUNCH_SLOTS,
): LaunchShelfPlan<T> {
  const storeSlots = Math.max(0, slots - MIN_SHELF_INVITES);
  // One slot is held back for a showcase store, so 4 real stores can't push them all
  // out — but real stores get everything else.
  const realTake = Math.min(real.length, Math.max(0, storeSlots - (demo.length ? MIN_SHELF_DEMO : 0)));
  // Day one (no real stores) the showcase stores ARE the mall and fill the row.
  // After that they drop to the minimum: they're filler, and crowding the row with
  // them is what buried the placeholder.
  const demoWanted = real.length > 0 ? MIN_SHELF_DEMO : demo.length;
  const demoTake = Math.min(demo.length, demoWanted, storeSlots - realTake);
  const stores = [...real.slice(0, realTake), ...demo.slice(0, demoTake)];
  return { stores, invites: Math.max(MIN_SHELF_INVITES, slots - stores.length) };
}
