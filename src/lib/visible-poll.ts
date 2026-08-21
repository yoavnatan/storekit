/**
 * A repeating network poll that does not run while the tab is hidden.
 *
 * Every long-lived screen here polls: notifications site-wide, seller unread, new orders, admin
 * badges. A plain `setInterval` keeps asking forever — a backgrounded tab a seller left open on
 * Friday is still hitting the API on Monday. Browsers throttle background timers to roughly once
 * a minute rather than stopping them, so the cost is not the 15s the code says: it is one request
 * per minute per open tab per user, indefinitely, for an answer nobody can see. The site-wide one
 * is on EVERY page, so it is every visitor with a forgotten tab, not just sellers.
 *
 * Two modules had already solved this independently and differently (`admin/tab-badges.ts` clears
 * the timer on hide and restarts it on show; `dashboard/custom-domain.ts` skips the fetch and
 * reschedules) while three others had not solved it at all. That spread is the reason this is one
 * function: the next poll to be written will copy whatever it finds, so there should be one thing
 * to find.
 *
 * Skipping the tick rather than clearing the timer, because it is the simpler invariant to keep
 * true — there is one timer for the lifetime of the page and no start/stop state to get wrong —
 * and the throttled tick that gets skipped costs nothing.
 *
 * Becoming visible fires the poll immediately, and that is not an optimisation: without it the
 * screen would show a stale badge for up to a full period after the person came back, which is
 * exactly the moment they are looking at it.
 */

/** How long the tab must have been hidden before returning counts as "catch up now". */
const CATCH_UP_AFTER_MS = 2_000;

export interface VisiblePoll {
  /** Runs the polled function now, off-schedule. The interval keeps its own cadence. */
  refresh(): void;
  /** Stops for good — for a screen that is torn down without a navigation. */
  stop(): void;
}

/**
 * Exactly `setInterval(fn, intervalMs)`, minus the ticks that land while the tab is hidden, plus
 * one call when the tab comes back. Deliberately does NOT fire on the way in: every call site
 * already decides for itself whether the first poll happens now or after a seed fetch, and
 * changing that from in here would fire a toast for orders that arrived between the server render
 * and page load.
 *
 * `fn` must swallow its own errors: a poll nobody is waiting on must never surface a failure, and
 * an unhandled rejection here would be reported as one. Every caller already does.
 */
export function pollWhileVisible(fn: () => void, intervalMs: number): VisiblePoll {
  let hiddenSince = document.hidden ? Date.now() : 0;

  const tick = (): void => {
    if (document.hidden) return;
    fn();
  };

  const onVisibility = (): void => {
    if (document.hidden) {
      hiddenSince = Date.now();
      return;
    }
    // A tab flicked away and back inside a couple of seconds (an alt-tab to copy something) has
    // nothing new to show, and re-firing on every such flick turns a quiet poll into a burst.
    if (hiddenSince && Date.now() - hiddenSince >= CATCH_UP_AFTER_MS) fn();
    hiddenSince = 0;
  };

  document.addEventListener('visibilitychange', onVisibility);
  const timer = window.setInterval(tick, intervalMs);

  return {
    refresh: tick,
    stop() {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
