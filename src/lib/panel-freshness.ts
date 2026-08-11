/**
 * "Click a tab, see current data" — the rule, in one place, for every dashboard that has tabs.
 *
 * All three dashboards render every panel once and then switch tabs by toggling `hidden`. That is
 * the right default for the switch itself (it is instant, and it cannot lose anything the user
 * typed), but it also means a panel shows the snapshot taken when the DOCUMENT loaded — for a
 * seller who leaves the dashboard open all day, that is data from this morning. The owner's
 * expectation (2026-08-11) is the plain one: opening a tab should show what is true now.
 *
 * **Why a staleness window rather than a fetch on every activation.** Toggling between two tabs to
 * compare them is a normal thing to do, and it would put three or four identical requests on the
 * wire inside a second — each one re-running the panel's queries to return the answer already on
 * screen. The window is what makes "refresh on open" affordable: the first open pays, and the
 * next few seconds of switching back and forth do not. Nobody can perceive the difference, because
 * nothing could have changed in that time that they were in a position to see.
 *
 * **What this module deliberately does NOT decide** is how a panel refreshes. The admin dashboard
 * already re-fetches its own HTML through `swapPanel`; the buyer's orders list has its own JSON
 * path. Both are correct for their surface, and a shared "refresher" abstraction over two
 * mechanisms this different would only be a third thing to keep in sync. What is genuinely one
 * rule — how long is too long, and when a refresh must be called off — lives here.
 */

/**
 * How long a panel's data stays trustworthy without asking again.
 *
 * 30s is chosen against what these panels actually report: a new order, a new message, an admin
 * count. None of them is a live figure anyone watches change — they are things you want to be
 * right when you go and look. The two dashboards that poll (seller/admin badges, both 15s) sit
 * comfortably inside it, so a tab that is already kept live by a poller is never re-fetched by
 * this on top.
 */
export const PANEL_STALE_MS = 30_000;

/**
 * Per-panel time of the last known-good load. Keyed by whatever the caller calls a panel — a DOM
 * id on the admin side, a tab name on the buyer's — because the two dashboards have no shared
 * vocabulary for "panel" and inventing one here would be a rename with no payer.
 *
 * **This is per-DOCUMENT state and must stay that way.** `admin-nav.ts` imports this module and is
 * itself imported by `admin/index.astro`'s frontmatter, so this Map also exists in the server
 * bundle — where it would be shared across every request and every admin, which is precisely the
 * shape the project's scalability rule forbids. It is safe today because only browser code ever
 * writes it. Do not call `markPanelFresh` from an API route or a page's frontmatter: one
 * request's stamp would then decide whether a different person's tab refreshes.
 */
const loadedAt = new Map<string, number>();

/** Record that `key`'s content is current as of now. Call this from the place that RECEIVES data,
 *  never from the place that requests it: a fetch that failed left the old content on screen, and
 *  stamping it fresh would suppress the retry that is the whole point. */
export function markPanelFresh(key: string): void {
  loadedAt.set(key, Date.now());
}

/** True when `key` has never loaded, or loaded longer than `ms` ago. */
export function isPanelStale(key: string, ms: number = PANEL_STALE_MS): boolean {
  const at = loadedAt.get(key);
  return at === undefined || Date.now() - at >= ms;
}

/** Forget `key`'s stamp, so the next activation refreshes whatever the window says. For the case
 *  where something else already knows the panel is wrong — a cross-tab save notice, say. */
export function invalidatePanel(key: string): void {
  loadedAt.delete(key);
}

/**
 * True if `root` contains a field the user has typed into and not yet saved.
 *
 * A refresh replaces content, and content is not always only content: a search box with a
 * half-typed query, a note being written, a filter set but not applied. Losing any of those to a
 * background refresh would be the same failure the seller dashboard's unsaved-guard and tab-sync
 * were built to prevent (owner, 2026-08-11: the refresh must not step on that behaviour) — and it
 * would be worse than the staleness it cures, because staleness is fixed by looking again and
 * typing is not.
 *
 * Compared against `defaultValue`/`defaultChecked` — what the server rendered — rather than
 * "is it non-empty": a field the server filled in is not something the user will miss, and
 * treating it as typed would leave any panel with a pre-filled filter permanently un-refreshable.
 *
 * This is the ambient half only. Where a form is genuinely guarded (`data-unsaved-guard`, seller
 * dashboard) that module stays the authority; this is the check for surfaces that have no guard
 * because they have no save button.
 *
 * A field marks itself `data-freshness-ignore` when the refresh CARRIES it — a live search box is
 * the case: its text is already part of the request the refresh is about to send, so it cannot be
 * lost, and counting it would leave the panel frozen from the first character the user ever typed
 * into it.
 */
export function panelHoldsTypedText(root: Element | null | undefined): boolean {
  if (!root) return false;
  const fields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  for (const f of fields) {
    // Buttons carry a `value` that is a label, and a disabled field is not something being edited.
    if (f instanceof HTMLInputElement && (f.type === 'button' || f.type === 'submit' || f.type === 'reset')) continue;
    if (f.disabled || f.hasAttribute('data-freshness-ignore')) continue;
    if (f instanceof HTMLInputElement && (f.type === 'checkbox' || f.type === 'radio')) {
      if (f.checked !== f.defaultChecked) return true;
      continue;
    }
    if (f.value !== f.defaultValue) return true;
  }
  return false;
}
