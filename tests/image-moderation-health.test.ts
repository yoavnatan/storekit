import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/db.js';
import { MODERATION_MISSING_MARKER } from '../src/lib/image-moderation.js';
import { getImageModerationState, moderationDeclaredOn } from '../src/lib/image-moderation-health.js';
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

async function logMissing(daysAgo: number) {
  await query(
    `INSERT INTO error_log (id, source, message, created_at)
     VALUES (gen_random_uuid(), 'client', $1, now() - make_interval(days => $2))`,
    [`${MODERATION_MISSING_MARKER} the upload came back with no moderation verdict`, daysAgo],
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
