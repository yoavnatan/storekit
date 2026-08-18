import { isTrackedAdminTab } from '../../lib/admin-tabs.js';

/**
 * Keeps the "(N)" on every admin tab current while the page stays open.
 *
 * **Why polling at all.** Switching tabs on this dashboard is a client-side `hidden` toggle — no
 * navigation — so an admin can sit on one tab for an hour, and until now every badge beside it was
 * whatever the server said at page load. That is precisely backwards for a signal whose only job is
 * to report the tab you are NOT looking at (owner, 2026-08-07). `GET /api/admin/tab-badges` is five
 * `COUNT`s in one statement, so a poll costs about what a `SELECT 1` costs.
 *
 * **Ordering, which is the only hard part.** Leaving a tab does two things at once: the badge is
 * cleared on screen and `POST /api/admin/tab-view` advances the boundary on the server. A poll that
 * left BEFORE that write lands still carries the old count, and applying it would put the badge the
 * admin just cleared straight back — the same number, apparently unclearable. So every acknowledged
 * departure bumps a generation, and a response stamped with an older one is dropped rather than
 * applied. `clearedLocally` covers the same instant from the other side: a tab cleared on screen
 * stays at zero until a poll issued after its write comes back.
 */
const ENDPOINT = '/api/admin/tab-badges';

/** Quiet enough that a badge is never more than a minute stale, cheap enough to leave running.
 *  Paused entirely while the document is hidden — a background tab has nobody to tell. */
const POLL_MS = 45_000;

let generation = 0;
const clearedLocally = new Set<string>();

/**
 * The BROWSER TAB's own "(N)" — every visible tab badge summed, read back off the strip.
 *
 * Derived from the spans rather than from a count of its own, deliberately: the strip is already
 * the one place that knows what has been cleared locally, what a poll has re-painted and what a
 * departure has zeroed, so a second source would be a second thing that can be wrong. Whatever the
 * admin can see on the tabs is what the title says, always.
 *
 * The title is seeded server-side by admin/index.astro (same five counts, same sum). This exists so
 * a dashboard left open in a background tab — the case the badges are FOR, since switching tabs
 * here never navigates — does not keep announcing a number that has since been read.
 *
 * The base title is recovered by stripping any leading "(N) " rather than captured once at load,
 * so a re-entry cannot stack "(2) (1) Admin Dashboard".
 */
export function syncAdminTitleBadge(): void {
  const spans = document.querySelectorAll<HTMLElement>('.dash-tab__count');
  if (spans.length === 0) return;
  let total = 0;
  spans.forEach((span) => {
    if (span.hidden) return;
    total += Number((span.textContent ?? '').replace(/\D+/g, '')) || 0;
  });
  const base = document.title.replace(/^\(\d+\)\s*/, '');
  document.title = total > 0 ? `(${total}) ${base}` : base;
}

function paint(counts: Record<string, number>): void {
  for (const [tab, count] of Object.entries(counts)) {
    if (clearedLocally.has(tab)) continue;
    const span = document.getElementById(`tab-count-${tab}`);
    if (!span) continue;
    const n = Number(count) || 0;
    span.textContent = n > 0 ? `(${n})` : '';
    span.hidden = n === 0;
  }
  syncAdminTitleBadge();
}

async function refresh(): Promise<void> {
  const issuedAt = generation;
  try {
    const res = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const counts = await res.json() as Record<string, number>;
    // A departure was acknowledged while this was in flight — its answer predates the boundary it
    // would be reporting against, so it is stale by construction.
    if (issuedAt !== generation) return;
    paint(counts);
  } catch {
    // silent: a background poll. A failed one is not worth telling anyone about: the previous numbers are still on screen and
    // still the best answer available. The next tick tries again.
  }
}

/**
 * Called by tab-nav.ts the moment a departure is recorded. `clearedLocally` holds that tab out of
 * every paint until the write has actually landed, then releases it and re-reads — so the badge
 * cannot flicker back on, and a row that arrived DURING the switch is still reported.
 */
export function acknowledgeTabLeft(tab: string, recorded: Promise<unknown>): void {
  if (!isTrackedAdminTab(tab)) return;
  generation += 1;
  clearedLocally.add(tab);
  void recorded.then(() => {
    generation += 1;
    clearedLocally.delete(tab);
    return refresh();
  }).catch(() => clearedLocally.delete(tab));
}

export function initAdminTabBadges(): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (timer !== undefined) return;
    timer = setInterval(() => void refresh(), POLL_MS);
  };
  const stop = () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stop(); return; }
    // Coming back to the page is the moment the numbers are most likely wrong, and the moment
    // someone is actually looking at them.
    void refresh();
    start();
  });
  if (!document.hidden) start();
}
