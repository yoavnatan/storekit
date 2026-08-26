/**
 * The admin bell's behaviour — the site's mechanism, on the admin's feed.
 *
 * `components/admin/AdminNotificationBell.astro` is the markup and says why it reuses the site's
 * classes. This is the other half, and it reuses the site's *mechanics* for the same reason: the
 * owner asked for the bell to work exactly like the one already on the site, and the parts of that
 * which matter are not the ones that are obvious.
 *
 * ── The three that are not obvious, each learned the hard way in BaseLayout.astro ──
 *
 * **1. The toast cursor is PERSISTED, not held in memory.** An in-memory "first poll" flag resets
 * on every page load, so the first poll after each reload re-toasts everything already unread — the
 * commonest case in a dashboard somebody keeps open and reloads. `localStorage` means only the very
 * first poll this browser ever runs suppresses a backlog.
 *
 * **2. The cursor is anchored to the newest ROW's own timestamp, never to the client's clock.** A
 * notification created server-side during the fetch's round trip has a `createdAt` earlier than the
 * client's "now", so a wall-clock cursor excludes it from the next `since=` window for ever — the
 * badge still counts it, and no toast ever fires. That is a silent, permanent miss.
 *
 * **3. Dedup is the toast layer's job, by KEY — and that is load-bearing, not belt-and-braces.**
 * Measured against the running server: a cursor set to a row's own `createdAt` still returns that
 * row on the next poll, because Postgres keeps microseconds and `toISOString()` keeps milliseconds,
 * so `created_at > '…123Z'` is still true for a row at `…123456`. The cursor is therefore an
 * approximation of "what is new" and cannot be the thing that prevents a repeat.
 * `ToastContainer` keeps a `shownKeys` set, so
 * passing each item's stable id means a row that is still unread on the next poll re-appears in the
 * feed and does NOT toast again. `admin-notifications.ts` builds those ids source-prefixed and
 * stable precisely so this works — an id derived from a row's position would toast the same seller
 * every fifteen seconds until somebody opened the tab.
 *
 * ── What is different here, and why ──────────────────────────────────────────
 *
 * A click SWAPS a panel instead of navigating: this dashboard is one page whose tabs never
 * navigate. The item carries a panel id from the server, so the "where does this lead" rule stays
 * in one place — the same reason `notification-link.ts` exists on the seller side.
 *
 * Opening the tab is what marks its items read, which happens by itself: `admin-tab-views.ts`
 * records the visit, the next poll measures against the new boundary, and the rows fall out of the
 * unread set. There is no mark-read call to make and nothing to remember.
 */
import { escapeHtml as escH } from '../../lib/html-escape.js';
import { updateBadge } from '../../lib/badge-ticker.js';
import { pollWhileVisible } from '../../lib/visible-poll.js';
import { swapPanel } from '../../lib/admin-nav.js';

interface AdminNotifItem {
  id: string;
  tab: string;
  title: string;
  body: string;
  createdAt: string;
  unread: boolean;
}

/** Matched to the site's own poll. Fifteen seconds is what makes a toast feel like it arrived
 *  rather than like it was found. */
const POLL_MS = 15_000;
/** At most three toasts from one poll, like the site's. A burst of thirty covers the screen and
 *  the thirtieth is no more useful than the bell's own number. */
const MAX_TOASTS_PER_POLL = 3;
/** On the very first poll this browser ever runs, only something genuinely fresh is worth a toast —
 *  everything older is a backlog the bell's number already reports. */
const FIRST_CHECK_RECENCY_MS = 30_000;
const CURSOR_KEY = '__adminNotifToastCursor';
/**
 * The ids this browser has already toasted — the half the cursor cannot cover.
 *
 * `ToastContainer` keeps its own `shownKeys` set and that closes the repeat WITHIN a page. It is in
 * memory, so a reload empties it, and the cursor does not close the gap that opens: measured
 * against the running server, a cursor set to a row's own `createdAt` still returns that row,
 * because Postgres keeps microseconds and `toISOString()` keeps milliseconds. So on the first poll
 * after every reload, the newest notification toasted a second time.
 *
 * Advancing the cursor by a millisecond was the obvious fix and is the wrong one: it would silently
 * skip anything created inside the same millisecond as the newest row. Remembering what was toasted
 * is exact, and it survives the reload the way the cursor does.
 *
 * Capped, and the cap is what keeps this from becoming a leak: a bell can raise thousands of these
 * over a year, and `localStorage` is a few megabytes shared with everything else on the origin. Two
 * hundred is far more than the fifty a poll can ever return, so an id can only fall out of this
 * list long after its row has fallen out of the feed.
 */
const TOASTED_KEY = '__adminNotifToasted';
const TOASTED_CAP = 200;

/** The tab labels, for the small line above each row. Read from the strip that is already on the
 *  page rather than repeated here — the tab list lives in `admin/index.astro`, and a second copy of
 *  its names is a second thing to update when one is renamed. */
function tabLabel(tab: string): string {
  return document.querySelector(`#tab-${CSS.escape(tab)} .dash-tab__label`)?.textContent?.trim()
    ?? document.getElementById(`tab-${tab}`)?.textContent?.trim()
    ?? '';
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'עכשיו';
  if (diff < 3600) return `לפני ${Math.floor(diff / 60)} דקות`;
  if (diff < 86400) return `לפני ${Math.floor(diff / 3600)} שעות`;
  return `לפני ${Math.floor(diff / 86400)} ימים`;
}

/**
 * Which of a poll's items get a toast, and which are merely remembered.
 *
 * Pure, exported and tested (`tests/admin-toast-selection.test.ts`) because every past complaint
 * about toasts on this project has been about this decision and never about the drawing of them:
 * one arriving twice, one arriving from an hour ago, one that never arrived because a cap ate the
 * budget. Reasoning about it inside a poller with a DOM and a clock is how those shipped.
 *
 * `toasted` is what this browser has already shown, restored from `localStorage` — the half the
 * cursor cannot cover, since a reload empties the toast layer's own in-memory set and the cursor
 * still returns the row it points at (microseconds against milliseconds).
 *
 * `show` is capped; `remember` is not, and the difference is deliberate — see the call site.
 */
export function pickToasts(
  items: readonly { id: string; createdAt: string }[],
  toasted: ReadonlySet<string>,
  opts: { firstEverCheck: boolean; now: number; cap: number; recencyMs: number },
): { show: string[]; remember: string[] } {
  const fresh = opts.firstEverCheck
    ? items.filter((n) => opts.now - new Date(n.createdAt).getTime() < opts.recencyMs)
    : items;
  // Before the cap, never after: a poll returning three already-toasted rows would otherwise spend
  // its whole budget on them and hide a genuinely new fourth.
  const unseen = fresh.filter((n) => !toasted.has(n.id)).map((n) => n.id);
  return { show: unseen.slice(0, opts.cap), remember: unseen };
}

export function initAdminNotifications(): void {
  const bellBtn = document.getElementById('admin-notif-bell-btn') as HTMLButtonElement | null;
  const drop = document.getElementById('admin-notif-dropdown') as HTMLElement | null;
  const list = document.getElementById('admin-notif-list') as HTMLElement | null;
  const badge = document.getElementById('admin-notif-count-badge') as HTMLElement | null;
  const loadingDot = document.getElementById('admin-notif-loading-dot') as HTMLElement | null;
  // Every element or none: the bell is one component, and a half-wired one is worse than an absent
  // one because it looks like it is working.
  if (!bellBtn || !drop || !list || !badge) return;
  // The dashboard re-runs its init on every panel swap (`wirePanelLinks`), and this bell lives
  // OUTSIDE the swapped region — so without this it would gain a second poller and a second set of
  // click handlers per tab the admin visits.
  if (bellBtn.dataset['ready'] === '1') return;
  bellBtn.dataset['ready'] = '1';

  const originalTitle = document.title.replace(/^\(\d+\)\s*/, '');

  function setBadge(count: number, opts?: { animate?: boolean }): void {
    updateBadge(badge!, count > 0 ? (count > 99 ? '99+' : String(count)) : null, opts);
    // The browser tab, so a dashboard left open in the background still says something arrived.
    // The page already writes this from the tab badges on load; both are the same five sources, so
    // they agree by construction rather than by luck.
    document.title = count > 0 ? `(${count}) ${originalTitle}` : originalTitle;
  }

  function render(items: AdminNotifItem[]): void {
    if (!items.length) {
      list!.innerHTML = '<p class="notif-empty">אין התראות חדשות</p>';
      return;
    }
    list!.innerHTML = items.map((n) => `
      <div class="notif-item${n.unread ? ' notif-item--unread' : ''}" data-tab="${escH(n.tab)}" role="button" tabindex="0">
        <div class="notif-item__tag">${escH(tabLabel(n.tab))}</div>
        <div class="notif-item__title">${escH(n.title)}</div>
        <div class="notif-item__body">${escH(n.body)}</div>
        <div class="notif-item__time">${escH(timeAgo(n.createdAt))}</div>
      </div>`).join('');

    // Bound per render, like every other list in this dashboard: the rows are replaced wholesale on
    // each poll, so a listener attached once would be pointing at elements that no longer exist.
    list!.querySelectorAll<HTMLElement>('[data-tab]').forEach((row) => {
      const go = (): void => {
        const tab = row.dataset['tab'] ?? '';
        if (!tab) return;
        close();
        // Through the strip's own button rather than `swapPanel` directly: the button is what marks
        // the tab active, records the visit and clears its badge. Calling the swap here would move
        // the panel and leave the strip pointing at the tab the admin just left — two answers to
        // "where am I", which is the drift a single entry point prevents.
        const tabBtn = document.getElementById(`tab-${tab}`) as HTMLButtonElement | null;
        if (tabBtn) tabBtn.click();
        else void swapPanel(`/admin?panel=${encodeURIComponent(tab)}`, `dash-panel-${tab}`, () => {});
      };
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    });
  }

  function open(): void {
    drop!.hidden = false;
    bellBtn!.setAttribute('aria-expanded', 'true');
    void load();
  }
  function close(): void {
    drop!.hidden = true;
    bellBtn!.setAttribute('aria-expanded', 'false');
  }

  /** The full list — what the dropdown shows and where the badge's number comes from. */
  async function load(): Promise<void> {
    loadingDot?.removeAttribute('hidden');
    try {
      const res = await fetch('/api/admin/notifications');
      if (!res.ok) return;
      const data = await res.json() as { notifications: AdminNotifItem[]; unreadCount: number };
      render(data.notifications ?? []);
      setBadge(data.unreadCount ?? 0);
    } catch {
      // silent: a background poll for a badge. Nothing is waiting on it, the last true number
      // stays on screen, and the next tick retries. Same rule as the site's own bell poll.
    } finally {
      loadingDot?.setAttribute('hidden', '');
    }
  }

  /**
   * The toasting half — a separate, `since=`-filtered request, exactly as on the site.
   *
   * It is separate from `load` on purpose. `load` answers "what is there", which is what a badge
   * and a dropdown need; this answers "what arrived since I last looked", which is the only
   * question a toast may be built on. One request serving both would either toast the backlog or
   * shrink the badge to the size of the new window.
   */
  let cursor = localStorage.getItem(CURSOR_KEY);
  let firstEverCheck = !cursor;

  /** Read defensively: a private window, cleared site data or a browser refusing storage all throw
   *  or answer null, and none of them is a reason for the bell to stop working. */
  function readToasted(): Set<string> {
    try {
      const raw = JSON.parse(localStorage.getItem(TOASTED_KEY) ?? '[]') as unknown;
      return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
    } catch { return new Set(); }
  }
  const toasted = readToasted();

  function rememberToasted(ids: readonly string[]): void {
    for (const id of ids) toasted.add(id);
    try {
      // Newest kept: `Set` preserves insertion order, so the tail is the most recent and the head
      // is what ages out.
      localStorage.setItem(TOASTED_KEY, JSON.stringify([...toasted].slice(-TOASTED_CAP)));
    } catch { /* silent: storage is a convenience here, and the in-memory set still holds. */ }
  }

  async function pollForToasts(): Promise<void> {
    try {
      const url = `/api/admin/notifications${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json() as { notifications: AdminNotifItem[]; unreadCount: number };
      const items = data.notifications ?? [];

      const { show, remember } = pickToasts(items, toasted, {
        firstEverCheck, now: Date.now(), cap: MAX_TOASTS_PER_POLL, recencyMs: FIRST_CHECK_RECENCY_MS,
      });
      /* EVERYTHING unseen is remembered, not only the three that get shown, and that is deliberate
         rather than a slip: a burst is capped at three on purpose, and the rest are reported by the
         number on the bell. The site's poller reaches the same outcome by moving its cursor past
         the whole batch. Remembering only the three would hold the other seven back for the next
         poll, and a burst of thirty would then trickle across two and a half minutes. */
      rememberToasted(remember);
      const byId = new Map(items.map((n) => [n.id, n]));
      for (const n of show.map((id) => byId.get(id)!)) {
        // `key` is what makes a repeat impossible — `ToastContainer` keeps a set of the keys it has
        // shown. The id is stable per source row, so an item that stays unread across ten polls
        // toasts exactly once.
        window.dispatchEvent(new CustomEvent('toast:show', {
          detail: { title: n.title, body: n.body, key: n.id },
        }));
      }
      firstEverCheck = false;
      // The newest ROW's own timestamp, never `Date.now()` — see the header's point 2.
      if (items.length) {
        cursor = items[0]!.createdAt;
        localStorage.setItem(CURSOR_KEY, cursor);
      }
      // The badge follows every poll, not only the ones that open the dropdown: a number that only
      // updates when somebody looks at it is not a signal about the tabs they are not looking at,
      // which is the whole purpose of this bell.
      setBadge(data.unreadCount ?? 0);
      // The dropdown is refreshed by a REAL fetch, never from `items` — that list is the
      // since-filtered batch, so rendering it into an open dropdown would replace the full list
      // with the two rows that arrived in the last fifteen seconds. The site's bell carries the
      // same warning in the same place.
      if (!drop!.hidden) void load();
    } catch {
      // silent: the fifteen-second toast poll. Nothing is waiting on it, the badge keeps the last
      // true number it was given, and the next tick retries — the same decision `load` above makes,
      // and the same one the site's own bell poll makes.
    }
  }

  bellBtn.addEventListener('click', () => { if (drop.hidden) open(); else close(); });
  document.getElementById('admin-notif-close-btn')?.addEventListener('click', close);
  document.addEventListener('click', (e) => {
    // `composedPath`, never `target.contains`: the list re-renders on a poll, so a click on a row
    // can be detached from the document by the time this fires and `contains` then answers false
    // for a click that really was inside — the trap `toolbar-portal.ts` records.
    if (drop.hidden) return;
    if (!e.composedPath().includes(drop) && !e.composedPath().includes(bellBtn)) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drop.hidden) close(); });

  // The first load fills the badge and the list. It is the only place the number comes from —
  // reading it back off the badge's own text to "reconcile" was a circle, and it wrote the value
  // `load` had just set.
  void load();
  pollWhileVisible(pollForToasts, POLL_MS);
}
