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
  /** Land in the target panel with its search box already holding this — what an order card's
   *  return chip uses to open the one case it is about (`lib/return-chip.ts`). */
  search?: string;
}

/**
 * ── An intent set AFTER the panel is already live (2026-08-20) ──
 *
 * Reading the intent once, at the target's init, was only ever half the mechanism — and the missing
 * half is invisible until a source is pressed TWICE. A panel is hydrated once per page load
 * (`fillPanel`/`hydrate` in dashboard.astro memoise it), so the second press recorded an intent that
 * nothing would ever read again: the tab opened and arrived with nothing applied. Rare for an
 * overview tile, which a seller passes through once; certain for the order card's return chip, which
 * sits on every row of a list he works down.
 *
 * So the panel REGISTERS what to do rather than asking once, and a later intent is delivered
 * straight to it. One applier per panel, two ways in — never two code paths doing the same thing.
 */
const pending: Record<string, PanelIntent | undefined> = {};
const appliers: Record<string, ((intent: PanelIntent) => void) | undefined> = {};

export function setPanelIntent(panel: string, intent: PanelIntent): void {
  const applier = appliers[panel];
  // ONE intent per panel while nobody is listening: an intent is a single act of navigation, not a
  // setting, so two presses before the panel lands mean the second one.
  if (applier) applier(intent);
  else pending[panel] = intent;
}

/**
 * The panel says what to do with an intent, and immediately drains one recorded before it existed.
 *
 * Called from the panel's own init. Registering replaces any previous applier, which is what a
 * store switch or a cross-tab refresh re-initialising the panel should do — the newest DOM is the
 * one the filter has to be applied to.
 */
export function onPanelIntent(panel: string, apply: (intent: PanelIntent) => void): void {
  appliers[panel] = apply;
  const waiting = pending[panel];
  if (waiting) {
    delete pending[panel];
    apply(waiting);
  }
}
