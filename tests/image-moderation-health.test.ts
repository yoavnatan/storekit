import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/db.js';
import { MODERATION_MISSING_MARKER } from '../src/lib/image-moderation.js';
import {
  clearModerationMissingReports, getImageModerationState, moderationDeclaredOn, MODERATION_STALE_DAYS,
} from '../src/lib/image-moderation-health.js';
import { getAdminTabBadges } from '../src/lib/admin-tab-badges.js';

/**
 * The state behind the admin Overview's "סינון תמונות" card.
 *
 * Against a real error_log, because the whole point of the module is a JOIN between two things that
 * were each correct alone: a report the browser files at upload time, and a lookup the admin's
 * landing page makes. A mocked query would assert the mock and leave exactly the seam this exists
 * to hold.
 */

const original = process.env.PUBLIC_IMAGE_MODERATION_ON;

async function logMissing(daysAgo: number, resolved = false) {
  await query(
    `INSERT INTO error_log (id, source, message, resolved, created_at)
     VALUES (gen_random_uuid(), 'client', $1, $3, now() - make_interval(days => $2))`,
    [`${MODERATION_MISSING_MARKER} the upload came back with no moderation verdict`, daysAgo, resolved],
  );
}

beforeEach(async () => {
  await query('DELETE FROM error_log');
});

afterEach(() => {
  if (original === undefined) delete process.env.PUBLIC_IMAGE_MODERATION_ON;
  else process.env.PUBLIC_IMAGE_MODERATION_ON = original;
});

describe('is anybody checking uploaded pictures right now', () => {
  it('is "off" when no add-on is declared, without asking the database at all', async () => {
    // Today's real state, and the reason the card exists: nothing was ever switched on, and until
    // this card there was no screen anywhere that said so.
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'false';
    expect(moderationDeclaredOn()).toBe(false);
    expect(await getImageModerationState()).toBe('off');

    delete process.env.PUBLIC_IMAGE_MODERATION_ON;
    expect(await getImageModerationState()).toBe('off');
  });

  it('only "true" counts as declared — no truthiness', async () => {
    // A half-set variable must read as OFF. Treating `1`/`yes`/`on` as enabled would mean a typo
    // silences the card while nothing is actually being filtered.
    for (const value of ['1', 'yes', 'on', 'TRUE', '']) {
      process.env.PUBLIC_IMAGE_MODERATION_ON = value;
      expect(moderationDeclaredOn(), `"${value}" must not count as declared`).toBe(false);
    }
    process.env.PUBLIC_IMAGE_MODERATION_ON = ' true ';
    expect(moderationDeclaredOn(), 'surrounding whitespace is a formatting accident, not intent').toBe(true);
  });

  it('is "ok" when declared and nothing has been reported', async () => {
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
    expect(await getImageModerationState()).toBe('ok');
  });

  it('is "stopped" once an upload reports that it ran unjudged', async () => {
    // The dangerous case: the quota ran out mid-month, uploads keep working, and without this the
    // only trace is one warning-level row among every browser exception the platform has collected.
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
    await logMissing(1);
    expect(await getImageModerationState()).toBe('stopped');
  });

  it('clears itself once the reports are old enough to be history', async () => {
    // A card that never goes away is furniture, and furniture is not read. A quota resets on the
    // billing date, so a report from six weeks ago describes a month that already ended.
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
    await logMissing(45);
    expect(await getImageModerationState()).toBe('ok');
  });

  it('ignores ordinary errors that merely happen to be in the log', async () => {
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
    await query(
      `INSERT INTO error_log (id, source, message) VALUES (gen_random_uuid(), 'server', $1)`,
      ['TypeError: cannot read properties of undefined'],
    );
    expect(await getImageModerationState()).toBe('ok');
  });
});

describe('what the Alerts tab badge counts', () => {
  const boundary = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const views = { sellers: boundary, stores: boundary, orders: boundary, alerts: boundary };

  beforeEach(async () => {
    await query('DELETE FROM user_reports');
  });

  it('counts a stopped filter ONCE, however many uploads reported it', async () => {
    // The rule the owner asked for, and the trap inside it. A stopped filter is reported by the
    // BROWSER on upload, so a seller loading a catalogue files one and twenty sellers file twenty —
    // for a single condition. "(20)" on the tab for one problem is how a number stops meaning
    // anything.
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
    for (let i = 0; i < 7; i++) await logMissing(1);
    expect((await getAdminTabBadges(views)).alerts).toBe(1);
  });

  it('adds nothing while no add-on is declared', async () => {
    // "Off" is the platform's standing configuration, not an incident. A badge that can never
    // reach zero is furniture — the section at the top of the tab is what says "off".
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'false';
    await logMissing(1);
    expect((await getAdminTabBadges(views)).alerts).toBe(0);
  });

  it('is dismissible: a report marked "טופל" stops holding the card and the badge open', async () => {
    /**
     * The card had no OFF switch, and it showed (2026-08-17): the add-on was enabled, an upload
     * came back judged, and the card still said "נעצר" because of the one report from before the
     * fix. The only thing that would have cleared it was the 21-day window expiring — a wait, not
     * a mechanism. The Alerts tab has carried "סמן כטופל" on every row all along
     * (`api/admin/errors.ts` → `setErrorResolved`); the query simply never read it.
     */
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
    await logMissing(1, true);
    expect(await getImageModerationState()).toBe('ok');
    // The badge answers the same question — a "(1)" over a dismissed card is the same bug wearing
    // a different hat.
    expect((await getAdminTabBadges(views)).alerts).toBe(0);
  });

  it('a dismissal silences the report, never the condition', async () => {
    // The property that makes dismissal safe: `resolved` is per ROW, so the next upload that comes
    // back unjudged writes a new one and the card is back. Nothing here can turn the alarm off for
    // good.
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
    await logMissing(1, true);
    expect(await getImageModerationState()).toBe('ok');
    await logMissing(0);
    expect(await getImageModerationState()).toBe('stopped');
    expect((await getAdminTabBadges(views)).alerts).toBe(1);
  });

  it('closes itself when an upload comes back judged — no click, no waiting', async () => {
    /**
     * The asymmetry this removes (owner, 2026-08-17: *"הוא לא יתעדכן אוטומטית בשום מצב?!"*). The card
     * knew about FAILURES only: an unjudged upload wrote a row, a judged one wrote nothing, and
     * silence cannot clear a warning — so the alarm's only exits were a person clicking "סמן כטופל"
     * or the report ageing out of the 21-day window three weeks later.
     *
     * `clearModerationMissingReports` is the missing signal, called from the browser the first time
     * an upload comes back with a verdict. The uploads were always the sampling; this is the same
     * sampling finally reporting the good news too.
     */
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
    await logMissing(1);
    await logMissing(3);
    expect(await getImageModerationState()).toBe('stopped');

    expect(await clearModerationMissingReports()).toBe(2);

    expect(await getImageModerationState()).toBe('ok');
    expect((await getAdminTabBadges(views)).alerts).toBe(0);
  });

  it('cannot silence the condition, only the reports that exist now', async () => {
    // The property that makes an automatic dismissal safe at all. It resolves rows, never a rule —
    // so the next unjudged upload writes a fresh one and the card is back on the next page load.
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
    await logMissing(1);
    await clearModerationMissingReports();
    expect(await getImageModerationState()).toBe('ok');

    await logMissing(0);
    expect(await getImageModerationState()).toBe('stopped');
  });

  it('writes nothing when there is nothing outstanding', async () => {
    // Every upload calls this once per page, so the common case is a no-op — it must not report work
    // it did not do, and must not touch rows outside the window it claims to be about.
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
    await logMissing(MODERATION_STALE_DAYS + 5);
    expect(await clearModerationMissingReports()).toBe(0);
  });

  it('still counts ordinary errors beside it, and does not double-count the reports', async () => {
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
    await logMissing(1);
    await logMissing(1);
    await query(
      `INSERT INTO error_log (id, source, message) VALUES (gen_random_uuid(), 'server', $1)`,
      ['TypeError: something else broke'],
    );
    // 1 for the ordinary error + 1 for the condition — never 3.
    expect((await getAdminTabBadges(views)).alerts).toBe(2);
  });
});
