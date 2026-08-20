// @vitest-environment jsdom
//
// Who is allowed to write a number into the BROWSER TAB.
//
// The bug this pins (owner, 2026-08-18): the admin dashboard's tab said "(1) Admin Dashboard" the
// moment a SELLER — a different account, in a different session, that the same browser happened to
// be signed into — received an order. `/admin` renders `isLoggedIn={false}` on purpose (an admin
// session is not a buyer/seller one, so it draws no bell and no avatar), but the notification
// poller was gated on the seller COOKIE instead of on the page, so it ran there anyway: a count
// with no bell on the page to explain it, no way to clear it, and two pollers hitting
// `/api/notifications` every 15s/30s for a widget that does not exist on that route.
//
// The rule, in one line: the tab may only carry a count that something visible ON THAT PAGE can
// explain. So the notification surface travels with `isLoggedIn` — the same gate the bell markup
// and its i18n slice already travel with — and the admin's tab carries the admin's OWN numbers,
// summed off its tab strip.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { syncAdminTitleBadge } from '../src/scripts/admin/tab-badges.js';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const BASE_LAYOUT = read('src/layouts/BaseLayout.astro');
const HEADER = read('src/components/Header.astro');
const ADMIN = read('src/pages/admin/index.astro');

describe('the notification poller is gated on the page, not on the cookie', () => {
  it('BaseLayout requires isLoggedIn as well as a session before it polls', () => {
    expect(BASE_LAYOUT).toMatch(/const notifySurface = isLoggedIn && !!sessionUserId;/);
    // The `{… && (<script …>)}` guard around the 15s poller. A regression here reads as
    // `{sessionUserId && (` — which is exactly what shipped.
    expect(BASE_LAYOUT).toMatch(/\{notifySurface && \(/);
    expect(BASE_LAYOUT).not.toMatch(/\{sessionUserId && \(/);
  });

  it('the unread count is not even read for a page that cannot show it', () => {
    expect(BASE_LAYOUT).toMatch(/const initialUnreadCount = notifySurface \?/);
  });

  it('window.__sessionUserId stays ungated — cart identity is a different question', () => {
    // It has to switch on EVERY page, admin included, or a shared computer keeps the previous
    // account's cart. Gating it with the notification surface would be a silent data leak.
    expect(BASE_LAYOUT).toMatch(/window\.__sessionUserId=uid;/);
  });

  it('Header only touches document.title where it drew a bell', () => {
    const titleWrites = [...HEADER.matchAll(/^.*document\.title = .*$/gm)].map((m) => m[0]!);
    expect(titleWrites).toHaveLength(1);
    expect(titleWrites[0]).toMatch(/if \(hasNotifUi\)/);
    expect(HEADER).toMatch(/const hasNotifUi = !!bellBtn;/);
  });

  it('Header does not poll /api/notifications on a page with no bell', () => {
    expect(HEADER).toMatch(/if \(hasNotifUi\) setInterval\(loadNotifs, \d+\);/);
    expect(HEADER).toMatch(/async function loadNotifs\(\) \{\s*\n\s*if \(!hasNotifUi\) return;/);
  });
});

describe('the admin tab carries the admin’s own numbers', () => {
  it('the server seeds the title from the same badges the strip shows', () => {
    // `badgeFor`, not `badgeCounts` — since 2026-08-20 the strip carries one badge the five-COUNT
    // query does not produce (`moneylog`, the reconciliation's discrepancy count), and the title has
    // to sum what is ON the strip. Summing `badgeCounts` would leave the title and the tabs saying
    // two different numbers, which is the exact disagreement this test exists to refuse.
    expect(ADMIN).toMatch(/const badgeTotal = Object\.values\(badgeFor\)\.reduce/);
    expect(ADMIN).toMatch(/title=\{badgeTotal > 0 \? `\(\$\{badgeTotal\}\) Admin Dashboard` : 'Admin Dashboard'\}/);
  });

  function strip(counts: (number | null)[]): void {
    document.title = 'Admin Dashboard | Dezabin';
    document.body.innerHTML = counts
      .map((n) => `<span class="dash-tab__count"${n === null ? ' hidden' : ''}>${n === null ? '' : `(${n})`}</span>`)
      .join('');
  }

  it('sums every visible badge and leaves the base title alone', () => {
    strip([3, 1, null]);
    syncAdminTitleBadge();
    expect(document.title).toBe('(4) Admin Dashboard | Dezabin');
  });

  it('drops the prefix entirely once everything has been read', () => {
    strip([null]);
    document.title = '(2) Admin Dashboard | Dezabin';
    syncAdminTitleBadge();
    expect(document.title).toBe('Admin Dashboard | Dezabin');
  });

  it('cannot stack prefixes when called twice', () => {
    strip([5]);
    syncAdminTitleBadge();
    syncAdminTitleBadge();
    expect(document.title).toBe('(5) Admin Dashboard | Dezabin');
  });

  it('leaves a page that has no admin tab strip untouched', () => {
    document.body.innerHTML = '';
    document.title = 'Some other page';
    syncAdminTitleBadge();
    expect(document.title).toBe('Some other page');
  });
});
