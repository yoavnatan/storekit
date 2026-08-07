import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { getAdminTabBadges } from '../src/lib/admin-tab-badges.js';
import { getAllLastViewedAt, recordTabView } from '../src/lib/admin-tab-views.js';
import { TRACKED_ADMIN_TABS } from '../src/lib/admin-tabs.js';

/**
 * The "(N)" badges on the admin tabs — the one signal on that dashboard whose ENTIRE job is to
 * report a tab the admin is not looking at (owner, 2026-08-07).
 *
 * Two halves, and the second is the one that matters longer term:
 *   1. the counts are right, and they move only when the boundary moves;
 *   2. they are still computed for EVERY tab once the page stops building every panel.
 *
 * Half 2 is a source scan, not a behaviour test, because the failure it guards against produces no
 * behaviour at all: derive a badge from a list the page no longer loads and it silently reads zero
 * — no error, no warning, and an owner who goes on trusting it. That is exactly what was about to
 * happen when panels became lazy, and it is the reason this file exists rather than a note.
 */

const ADMIN_PAGE = path.join(process.cwd(), 'src/pages/admin/index.astro');

describe('the badge counts', () => {
  const OLD = '2020-01-01T00:00:00.000Z';

  beforeEach(async () => {
    await query('DELETE FROM error_log');
    for (const tab of TRACKED_ADMIN_TABS) await recordTabView(tab, OLD);
  });

  it('counts only what arrived after the boundary', async () => {
    const before = await getAdminTabBadges(await getAllLastViewedAt());
    await query(
      `INSERT INTO error_log (id, source, message, created_at) VALUES ($1, 'server', 'boom', now())`,
      [crypto.randomUUID()],
    );
    expect((await getAdminTabBadges(await getAllLastViewedAt())).alerts).toBe(before.alerts + 1);

    // Leaving the tab is what turns a row from new to seen — the boundary moves, the badge empties.
    await recordTabView('alerts');
    expect((await getAdminTabBadges(await getAllLastViewedAt())).alerts).toBe(0);
  });

  it('returns numbers, not the bigint strings `count` comes back as', async () => {
    // `pg` hands a bigint back as a string and PGlite as a number. Left alone, `count === 0` would
    // never be true and the badge would render on a tab with nothing new in it.
    const badges = await getAdminTabBadges(await getAllLastViewedAt());
    for (const [tab, n] of Object.entries(badges)) {
      expect(typeof n, tab).toBe('number');
      expect(Number.isInteger(n), tab).toBe(true);
    }
  });

  it('counts one multi-store purchase once, like the tab it sits on', async () => {
    // The Orders tab lists PURCHASES: a five-store cart is one card there, so a badge counting
    // order ROWS would announce "5 new" above a list showing one.
    const before = (await getAdminTabBadges(await getAllLastViewedAt())).orders;
    const [ref, pay] = ['CKGRP001', 'PAYGRP001'];
    // Three rows, one purchase — the shape migration 0017 made possible by dropping the UNIQUE on
    // `payment_ref` that had been failing every multi-store cart outright.
    for (let i = 0; i < 3; i++) {
      await query(
        `INSERT INTO orders (id, buyer_name, buyer_email, buyer_phone, shipping_agorot, total_agorot,
                             payment_ref, payment_status, shipping_status, checkout_ref, created_at, updated_at)
         VALUES ($1, 'b', 'b@example.com', '0500000000', 0, 1000, $2, 'paid', 'pending', $3, now(), now())`,
        [crypto.randomUUID(), pay, ref],
      );
    }
    expect((await getAdminTabBadges(await getAllLastViewedAt())).orders).toBe(before + 1);
  });
});

describe('every badge survives a dashboard that only builds one panel', () => {
  /**
   * The rule, stated as a scan of the page itself: EVERY count that reaches a tab or a panel comes
   * from `badgeCounts`, i.e. from the one query that runs whatever panel was asked for. Anything
   * else on that page is a roster or a log loaded for a PANEL, and those loads are conditional.
   *
   * Written as "every `newCount` must look like this" rather than "these three names must not
   * appear", because the second phrasing only catches the mistakes already made — and the mistake
   * here is generic: counting in JS whatever list happens to be in scope.
   */
  it('takes its counts from getAdminTabBadges, never from a panel list', () => {
    const source = fs.readFileSync(ADMIN_PAGE, 'utf8');
    expect(source).toContain('getAdminTabBadges(newSince)');
    // `countSince` is the in-JS counter the badges used to use. Its remaining callers are elsewhere;
    // on this page it must not come back.
    expect(source).not.toMatch(/\bcountSince\s*\(/);

    const counts = [...source.matchAll(/newCount=\{([^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(counts.length).toBeGreaterThanOrEqual(4);
    for (const expr of counts) {
      expect(expr, 'a panel count must come from badgeCounts — anything else reads 0 when that panel is not built')
        .toMatch(/^badgeCounts\.\w+$/);
    }
    // The tab strip itself reads the same object, so the badge and the panel cannot disagree.
    expect(source).toMatch(/const badgeFor: Record<string, number> = badgeCounts;/);
    expect(source).toMatch(/badgeFor\[tab\.id\]/);
  });

  it('passes each panel the SAME number the tab shows', () => {
    // The badge, the "חדש" chip on each row and the "חדשים בלבד (N)" filter are three views of one
    // fact. They disagree the moment a panel is handed a count from somewhere else.
    const source = fs.readFileSync(ADMIN_PAGE, 'utf8');
    for (const tab of ['sellers', 'stores', 'orders', 'alerts']) {
      expect(source, tab).toContain(`newCount={badgeCounts.${tab}}`);
    }
  });

  it('reads the boundary without advancing it', () => {
    // Rendering /admin used to advance `newSince`, so the tab said "(3) new" while the rows inside
    // carried no mark — and every in-panel AJAX refresh wiped the marks mid-session. The only
    // writer is POST /api/admin/tab-view.
    const source = fs.readFileSync(ADMIN_PAGE, 'utf8');
    expect(source).toContain('getAllLastViewedAt()');
    expect(source).not.toMatch(/\brecordTabView\s*\(/);
  });
});
