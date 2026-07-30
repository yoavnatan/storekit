/**
 * Cross-tab awareness for the seller dashboard.
 *
 * A seller routinely leaves the dashboard open in several tabs. Everything the
 * dashboard renders is a snapshot taken at load, so the moment he saves in one
 * tab every other tab is showing data that is quietly wrong — and the next save
 * from one of them would push that stale snapshot back to the server.
 *
 * Two mechanisms, deliberately separate, because they cover different failures:
 *  - THIS module is the ambient half: it tells the other tabs, right away, that
 *    what they show is out of date, and offers a reload. It is advisory — the
 *    seller is never interrupted and nothing on screen moves under him.
 *  - `lib/record-rev.ts` is the safety half: the server refuses a save built on a
 *    revision that has moved. That one also covers a second device / another
 *    browser, which no client-side channel can see.
 *
 * The notice is raised by observing `fetch` once, rather than by a call at every
 * save site. There are ~20 mutating calls across the dashboard scripts today and
 * new ones land every session; a list of call sites to remember to update is a
 * rule that rots, while one observer covers the ones already written and the ones
 * written next. The wrapper only looks at the response — a failure inside it can
 * never affect the request it observed.
 *
 * BroadcastChannel never delivers to the context that posted, so the tab that
 * saved never nags itself. Where it doesn't exist the module simply does nothing:
 * the revision guard still refuses the stale save, which is the part that matters.
 */

import { hasUnsavedChanges } from './unsaved-guard.js';

const CHANNEL_NAME = 'dezabin-seller-dashboard';

/** Mutating calls that change something a dashboard tab is displaying. Anything not listed (reads, pagination, previews, error logging) leaves the other tabs alone. */
const MUTATION_PATHS = [
  '/api/product',
  '/api/store',
  '/api/store-category',
  '/api/store-product/',
  '/api/seller/orders',
  '/api/seller/ad-campaigns',
  '/api/messages',
  '/api/admin-messages',
];

interface DashChange { type: 'dash:changed'; storeId: string }

let channel: BroadcastChannel | null = null;
let currentStoreId = '';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  return input.url;
}

function isMutation(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method === 'GET' || method === 'HEAD') return false;
  let path: string;
  try { path = new URL(requestUrl(input), window.location.origin).pathname; } catch { return false; }
  return MUTATION_PATHS.some((p) => path === p || path.startsWith(p));
}

/**
 * How a panel brings itself up to date, registered by the panel's own module.
 *
 * A registry rather than tab-sync reaching into each panel: every list tab already owns
 * one function that re-fetches its current page/search/sort/filter state and patches its
 * rows (the toolbar funnels every control through it), and that is exactly the right
 * thing to re-run here — a cross-tab refresh then cannot drift from a normal one, and
 * the seller's page, filters, selection and decoded thumbnails all survive it. Those
 * functions are closures over each tab's state, so they hand themselves in instead of
 * being imported. A panel that registers nothing simply gets the notice.
 */
const refreshers = new Map<string, () => Promise<void>>();

export function registerPanelRefresh(panelId: string, refresh: () => Promise<void>): void {
  refreshers.set(panelId, refresh);
}

/**
 * Surfaces that must never be redrawn from under the seller. A live refresh replaces a
 * panel's rows wholesale, so it is only allowed while he is reading — the moment anything
 * is open, expanded or half-typed, the notice takes over and HE picks the moment. Same
 * principle as the bar itself: nothing moves unasked.
 */
function isBusy(panel: Element): boolean {
  if (hasUnsavedChanges()) return true;
  // Literally inside a field — an order's tracking number, a note, a reply.
  const focused = document.activeElement;
  if (focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) return true;
  // Anything expanded or open: an order card, a message thread, a kebab menu, a dropdown
  // trigger — they all mark themselves aria-expanded, which is also what a screen reader
  // reads, so there is no second source of truth to keep in sync.
  if (panel.querySelector('[aria-expanded="true"]')) return true;
  // An open edit row / add-product box / bulk panel — untouched or not, its fields would
  // be swapped out mid-look.
  if (panel.querySelector('.edit-row:not([hidden])')) return true;
  if (!document.getElementById('add-product-form')?.hidden) return true;
  if (!document.getElementById('bulk-upload-panel')?.hidden) return true;
  // A floating dropdown (filter/sort menus) or any modal: re-rendering the rows
  // underneath moves the ground the menu is anchored to.
  if (document.querySelector('.toolbar-portal')) return true;
  if (document.querySelector('dialog[open]')) return true;
  return false;
}

/** Brings the panel on screen up to date silently. False = it declined, which is what raises the notice instead. */
async function refreshQuietly(): Promise<boolean> {
  // Only the ACTIVE panel counts: quietly refreshing a hidden one while the seller reads
  // a stale Settings tab would suppress the notice he actually needs.
  const active = document.querySelector('.dash-panel:not([hidden])');
  if (!active) return false;
  const refresh = refreshers.get(active.id);
  if (!refresh || isBusy(active)) return false;
  try {
    await refresh();
    document.getElementById('dash-stale-bar')?.classList.add('!hidden');
    return true;
  } catch { return false; }
}

/** Shows the notice in THIS tab. Also called by a save that came back 409 — that save's own tab is stale too, and it just proved it. */
export function markDashboardStale(): void {
  const bar = document.getElementById('dash-stale-bar');
  if (!bar || !bar.classList.contains('!hidden')) return;
  bar.classList.remove('!hidden');
  bar.animate(
    [{ opacity: 0, transform: 'translate(-50%, 8px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }],
    { duration: 220, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  );
}

/**
 * The conflict dialog's text, naming the fields actually in dispute.
 *
 * Worth the field names: since the save is merged field by field (lib/record-rev.ts),
 * the seller is only ever asked about the one or two values two tabs set differently —
 * everything else is already safe. "The product changed" would leave him guessing what
 * he is about to decide; "מחיר" tells him exactly.
 */
export function conflictMessage(fields: string[] | undefined, i18n: Record<string, unknown>): string {
  const labels = (i18n.conflictField ?? {}) as Record<string, string>;
  const named = (fields ?? []).map((f) => labels[f]).filter(Boolean);
  if (!named.length) return String(i18n.conflictGenericMsg ?? 'This was updated in another tab. Saving keeps the values typed here.');
  return `${String(i18n.conflictFieldsPrefix ?? '')} ${named.join(', ')}. ${String(i18n.conflictChooseMsg ?? '')}`.trim();
}

export function initDashTabSync(storeId: string): void {
  currentStoreId = storeId;

  const bar = document.getElementById('dash-stale-bar');
  document.getElementById('dash-stale-refresh')?.addEventListener('click', () => window.location.reload());
  document.getElementById('dash-stale-dismiss')?.addEventListener('click', () => bar?.classList.add('!hidden'));

  if (typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(CHANNEL_NAME);

  channel.addEventListener('message', (e: MessageEvent<DashChange>) => {
    // Another tab on a DIFFERENT store of the same seller changed nothing this
    // tab is showing (the multi-store switcher makes that a normal state).
    if (e.data?.type !== 'dash:changed' || e.data.storeId !== currentStoreId) return;
    // Update in place if it can be done invisibly; otherwise say so and let the seller
    // choose when. The notice is the fallback, not the default.
    void refreshQuietly().then((done) => { if (!done) markDashboardStale(); });
  });

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await origFetch(input, init);
    try {
      if (res.ok && isMutation(input, init)) {
        channel?.postMessage({ type: 'dash:changed', storeId: currentStoreId } satisfies DashChange);
      }
    } catch { /* observation must never break the call it observed */ }
    return res;
  };
}
