// @vitest-environment jsdom
/**
 * `pollWhileVisible` — the one thing standing between a forgotten tab and a request a minute,
 * forever. Its whole value is in what it does NOT do, which is the kind of behaviour that rots
 * silently: nothing on screen changes if the gate stops working.
 *
 * Why the boundaries below are the ones tested:
 *  • a hidden tick must not call through, or the helper is decoration;
 *  • returning after a real absence must call through, or the badge someone came back to look at
 *    is stale for a whole period at exactly the wrong moment;
 *  • a flick away and straight back must NOT, or an alt-tab to copy a tracking number turns one
 *    quiet poll into a burst;
 *  • the first call belongs to the caller, not to this — orders.ts seeds its watermark before its
 *    first poll, and firing on the way in would toast orders that arrived before the page loaded.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { pollWhileVisible } from '../src/lib/visible-poll.js';

/** jsdom's `document.hidden` is derived from visibilityState, which is not writable either. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  setHidden(false);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pollWhileVisible', () => {
  it('does not call on the way in — the caller owns the first poll', () => {
    const fn = vi.fn();
    pollWhileVisible(fn, 1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('ticks on the interval while the tab is visible', () => {
    const fn = vi.fn();
    pollWhileVisible(fn, 1000);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('skips every tick while the tab is hidden', () => {
    const fn = vi.fn();
    pollWhileVisible(fn, 1000);
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('catches up once when the tab comes back after a real absence', () => {
    const fn = vi.fn();
    pollWhileVisible(fn, 60_000);
    setHidden(true);
    vi.advanceTimersByTime(5000);
    setHidden(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not catch up on a flick away and straight back', () => {
    const fn = vi.fn();
    pollWhileVisible(fn, 60_000);
    setHidden(true);
    vi.advanceTimersByTime(500);
    setHidden(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('resumes ticking after the tab comes back', () => {
    const fn = vi.fn();
    pollWhileVisible(fn, 1000);
    setHidden(true);
    vi.advanceTimersByTime(3000);
    setHidden(false);
    fn.mockClear(); // drop the catch-up call; what matters is the interval living on
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stop() ends both the timer and the visibility listener', () => {
    const fn = vi.fn();
    const poll = pollWhileVisible(fn, 1000);
    poll.stop();
    vi.advanceTimersByTime(5000);
    setHidden(true);
    vi.advanceTimersByTime(5000);
    setHidden(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('refresh() polls off-schedule, and not while hidden', () => {
    const fn = vi.fn();
    const poll = pollWhileVisible(fn, 60_000);
    poll.refresh();
    expect(fn).toHaveBeenCalledTimes(1);
    setHidden(true);
    poll.refresh();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
