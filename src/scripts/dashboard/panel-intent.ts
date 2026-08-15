/**
 * "Open that tab, and arrive with this already applied."
 *
 * The overview's tiles say things like "3 הזמנות חדשות" and are meant to land the seller in the
 * Orders tab with the pending filter on. The behaviour that applies such a filter lives in the
 * TARGET panel's module — and since panels arrive one fetch at a time (2026-08-11), that module is
 * usually not loaded at the moment the tile is pressed. Binding the tile from the target's module
 * is what the dashboard used to do, and it made three tiles on the landing page dead for any seller
 * who had not already visited the tab they lead to.
 *
 * So the tile does not reach into another panel at all. It records an intent and clicks the tab;
 * the target panel's own init asks whether one is waiting, exactly once. Neither side imports the
 * other, which is also why this is its own small module rather than a field on either of them —
 * the same reason `category-tree-cache.ts` exists.
 *
 * ONE intent per panel, and taking it clears it: an intent is a single act of navigation, not a
 * setting. If the seller presses two tiles before the panel lands, the last press is the one they
 * meant.
 */
export interface PanelIntent {
  /** Statuses to filter the target list by, if it has a status filter. */
  status?: string[];
  /** The products tab's "stock needs attention" view. */
  stockAttention?: true;
}

const pending: Record<string, PanelIntent | undefined> = {};

export function setPanelIntent(panel: string, intent: PanelIntent): void {
  pending[panel] = intent;
}

/** What the caller was asked to arrive with — and it is consumed, so a later re-init of the same
 *  panel (a cross-tab refresh, a store switch) does not silently re-apply a filter nobody asked
 *  for a second time. */
export function takePanelIntent(panel: string): PanelIntent | undefined {
  const intent = pending[panel];
  delete pending[panel];
  return intent;
}
