import { describe, expect, it } from 'vitest';
import { pickToasts } from '../src/scripts/admin/notifications.js';

/**
 * Which notifications get a toast — the decision every past toast complaint on this project was
 * actually about.
 *
 * The owner asked the question this file answers (2026-08-26): *"ואין טוסט שמחכה מפעם קודמת וכאלה
 * שיחזרו על עצמם? היו הרבה תקלות"*. Three failures are possible here and each has shipped
 * somewhere before: the same notification toasting twice, a backlog toasting all at once on a first
 * visit, and a real arrival never toasting because a cap was spent on rows already shown.
 *
 * The cases below are those three, plus the one that made this extraction worth doing: **a reload**.
 * `ToastContainer`'s own dedup is an in-memory set, so it is empty after every reload, and the
 * server cursor does not cover the gap — measured against the running server, a cursor set to a
 * row's own `createdAt` still returns that row, because Postgres keeps microseconds and
 * `toISOString()` keeps milliseconds. The persisted `toasted` set is what closes it, and this is
 * where that is proved rather than argued.
 */

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const item = (id: string, msAgo = 0) => ({ id, createdAt: at(msAgo) });
const OPTS = { firstEverCheck: false, now: NOW, cap: 3, recencyMs: 30_000 };

describe('a toast never repeats', () => {
  it('skips what this browser has already shown', () => {
    const { show } = pickToasts([item('error:a'), item('error:b')], new Set(['error:a']), OPTS);
    expect(show).toEqual(['error:b']);
  });

  it('shows nothing at all when the whole batch was already shown', () => {
    // The reload case. The poll returns the same rows — the cursor points at the newest one and
    // still matches it — and the toast layer's own set is empty because the page is new. Without
    // the persisted set this is where the duplicate came from.
    const items = [item('error:a'), item('seller:b')];
    const { show } = pickToasts(items, new Set(['error:a', 'seller:b']), OPTS);
    expect(show).toEqual([]);
  });

  it('remembers everything unseen, so the next poll repeats none of it', () => {
    const items = [item('a'), item('b'), item('c'), item('d'), item('e')];
    const first = pickToasts(items, new Set(), OPTS);
    expect(first.show).toEqual(['a', 'b', 'c']);
    // The other two are capped away and reported by the bell's number, exactly as the site's cursor
    // does by moving past the whole batch.
    expect(first.remember).toEqual(['a', 'b', 'c', 'd', 'e']);

    const second = pickToasts(items, new Set(first.remember), OPTS);
    expect(second.show).toEqual([]);
  });
});

describe('the cap is spent on what is new', () => {
  it('does not let already-shown rows eat the budget', () => {
    // The failure this ordering prevents: filter after slicing and a poll holding three seen rows
    // plus one genuinely new one shows nothing, so a real arrival is silently swallowed.
    const items = [item('seen1'), item('seen2'), item('seen3'), item('brand-new')];
    const { show } = pickToasts(items, new Set(['seen1', 'seen2', 'seen3']), OPTS);
    expect(show).toEqual(['brand-new']);
  });

  it('caps a burst rather than covering the screen', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`e${i}`));
    expect(pickToasts(items, new Set(), OPTS).show).toHaveLength(3);
  });
});

describe('the first visit this browser ever makes', () => {
  it('stays quiet about a backlog', () => {
    // No cursor yet, so the server answers with everything it has. Toasting a week of errors at
    // somebody opening the dashboard for the first time is the "waiting from last time" complaint.
    const items = [item('old1', 3 * 3_600_000), item('old2', 86_400_000)];
    const { show } = pickToasts(items, new Set(), { ...OPTS, firstEverCheck: true });
    expect(show).toEqual([]);
  });

  it('still announces something that arrived seconds ago', () => {
    // A blanket first-poll suppression was the version that swallowed a genuinely fresh arrival —
    // very often the one raised while the page was loading. Only what is older than the window is
    // held back.
    const items = [item('fresh', 5_000), item('old', 3 * 3_600_000)];
    const { show } = pickToasts(items, new Set(), { ...OPTS, firstEverCheck: true });
    expect(show).toEqual(['fresh']);
  });

  it('remembers only what it actually considered, so the backlog can never toast later', () => {
    // `remember` follows the same recency filter: the old rows are neither shown NOR remembered, so
    // if one of them is somehow still in a later window it is judged on its own merits rather than
    // silently suppressed for ever.
    const items = [item('fresh', 5_000), item('old', 3 * 3_600_000)];
    expect(pickToasts(items, new Set(), { ...OPTS, firstEverCheck: true }).remember).toEqual(['fresh']);
  });
});

describe('nothing to do', () => {
  it('is quiet on an empty poll', () => {
    expect(pickToasts([], new Set(), OPTS)).toEqual({ show: [], remember: [] });
  });
});
