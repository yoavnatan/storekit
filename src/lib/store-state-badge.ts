/** The admin-facing label for a store's state (lib/store-status.ts), defined once.
 *
 *  Four surfaces list stores for an admin — the Stores tab, the Sellers tab, the Performance
 *  table (rendered client-side from JSON) and the two per-store pages — and each grew its own
 *  inline `{store.blocked && <span>חסום</span>}`. That was already the same string four times
 *  when there was ONE state to report; with five, the copies would have drifted the day this
 *  feature landed, and three of the four would still be claiming a paused store is fine.
 *
 *  Pure and copy-only: it names the state, it does not decide anything. Colour follows meaning,
 *  not loudness — an admin block is the platform acting against the store (danger), a pause or a
 *  pending closure is the seller's own decision (warning), and a closed store is simply finished
 *  (neutral). An active store gets no badge at all: an admin scans these lists for the ones that
 *  are NOT normal.
 */
import { storeLifecycle, type StoreLifecycleFlags } from './store-status.js';

export interface StoreStateBadge {
  label: string;
  /** Suffix of the `.admin-badge--*` class (styles/pages/admin.css). */
  variant: 'failed' | 'warning' | 'muted';
}

const BADGES: Partial<Record<ReturnType<typeof storeLifecycle>, StoreStateBadge>> = {
  blocked: { label: 'חסום', variant: 'failed' },
  // Not a fault and not a penalty — the shop is built and waiting on clearing or on a subscription
  // (`store-publication.ts`), which is why it takes the same muted treatment as a closed store
  // rather than the warning colour the seller-caused halts get.
  unpublished: { label: 'לפני עלייה לאוויר', variant: 'muted' },
  paused: { label: 'מוקפאת', variant: 'warning' },
  closing: { label: 'לקראת סגירה', variant: 'warning' },
  closed: { label: 'סגורה', variant: 'muted' },
};

export function storeStateBadge(store: StoreLifecycleFlags): StoreStateBadge | null {
  return BADGES[storeLifecycle(store)] ?? null;
}

/** Same answer for a surface that only carries the resolved state. Not exported: every caller
 *  outside this file has a store record or a wire row, and the two wrappers below are what they
 *  should reach for. */
function stateBadge(state: ReturnType<typeof storeLifecycle>): StoreStateBadge | null {
  return BADGES[state] ?? null;
}

/** …and for one of those rows as it arrives over the wire. `state` was added beside the older
 *  `blocked` boolean rather than replacing it (zero-downtime deploys — AI_INSTRUCTIONS → Hard
 *  rules), so a row served by the previous version carries only the boolean. The fallback lives
 *  HERE, once, rather than in each of the two renderers that draw this table: put it in both and
 *  the SSR pass and the client redraw are one edit away from labelling the same store
 *  differently. */
export function rowStateBadge(row: { state?: ReturnType<typeof storeLifecycle>; blocked?: boolean }): StoreStateBadge | null {
  return stateBadge(row.state ?? (row.blocked ? 'blocked' : 'active'));
}
