import { describe, expect, it } from 'vitest';
import { pickToasts } from '../src/scripts/admin/notifications.js';

/**
 * A toast is for a notification that arrives WHILE YOU ARE WATCHING.
 *
 * The owner's rule, and the whole decision in one sentence (2026-08-27): *"הרעיון הוא טוסט רק כאשר
 * ההתראה נכנסת, בלייב."* He proved the old behaviour wrong by opening the demo and being shown a
 * card about something five hours old — *"עובדה: ההתראה התקבלה לפני 5 שעות ועדיין רואה טוסט"*.
 *
 * What was there before was a per-browser "first check ever" flag plus a thirty-second recency
 * window. More moving parts and still wrong: on every visit after the first, everything accumulated
 * since the last one arrived at once. The bell's number is what reports a backlog; a toast that
 * announces the past is the site talking about itself.
 *
 * So the first poll of each page load shows nothing and only records what is there. Every later
 * poll is, by construction, about the fifteen seconds since — with somebody present to see it.
 */

const item = (id: string) => ({ id, createdAt: new Date().toISOString() });
const LIVE = { firstPollOfThisPage: false, cap: 3 };
const LANDING = { firstPollOfThisPage: true, cap: 3 };

describe('landing on a page', () => {
  it('shows nothing at all, however much is waiting', () => {
    const waiting = Array.from({ length: 10 }, (_, i) => item(`n${i}`));
    expect(pickToasts(waiting, new Set(), LANDING).show).toEqual([]);
  });

  it('still REMEMBERS what was there, so the next poll does not call it news', () => {
    const waiting = [item('a'), item('b')];
    const first = pickToasts(waiting, new Set(), LANDING);
    expect(first.remember).toEqual(['a', 'b']);
    // Second poll, same rows still inside the cursor's window: nothing to announce.
    expect(pickToasts(waiting, new Set(first.remember), LIVE).show).toEqual([]);
  });
});

describe('while you are watching', () => {
  it('announces what arrives', () => {
    const seen = new Set(['old1', 'old2']);
    const poll = [item('brand-new'), item('old1'), item('old2')];
    expect(pickToasts(poll, seen, LIVE).show).toEqual(['brand-new']);
  });

  it('never repeats one it has already shown', () => {
    const poll = [item('a')];
    const first = pickToasts(poll, new Set(), LIVE);
    expect(first.show).toEqual(['a']);
    expect(pickToasts(poll, new Set(first.remember), LIVE).show).toEqual([]);
  });

  it('caps a burst rather than covering the screen', () => {
    const burst = Array.from({ length: 30 }, (_, i) => item(`e${i}`));
    expect(pickToasts(burst, new Set(), LIVE).show).toHaveLength(3);
  });

  it('does not let already-shown rows eat the cap', () => {
    // Filter after the slice and a poll holding three seen rows plus one genuinely new one shows
    // nothing — a real arrival swallowed by its own history.
    const poll = [item('seen1'), item('seen2'), item('seen3'), item('brand-new')];
    expect(pickToasts(poll, new Set(['seen1', 'seen2', 'seen3']), LIVE).show).toEqual(['brand-new']);
  });

  it('remembers everything unseen, not only what it showed', () => {
    // A burst is capped on purpose and the rest are reported by the bell's number — holding them
    // back would make thirty arrivals trickle across two and a half minutes.
    const burst = Array.from({ length: 5 }, (_, i) => item(`e${i}`));
    const { show, remember } = pickToasts(burst, new Set(), LIVE);
    expect(show).toHaveLength(3);
    expect(remember).toHaveLength(5);
  });
});

describe('nothing to do', () => {
  it('is quiet on an empty poll, landing or live', () => {
    expect(pickToasts([], new Set(), LIVE)).toEqual({ show: [], remember: [] });
    expect(pickToasts([], new Set(), LANDING)).toEqual({ show: [], remember: [] });
  });
});
