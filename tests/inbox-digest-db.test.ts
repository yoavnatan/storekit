import { describe, it, expect, beforeEach, vi } from 'vitest';
import { query } from '../src/lib/db.js';
import { createInquiryThread, replyToAdminThread, setAdminThreadStatus } from '../src/lib/admin-messages.js';
import { collectInboxDigest, runInboxDigest } from '../src/lib/inbox-digest.js';
import * as emailModule from '../src/lib/email/index.js';

/**
 * The one thing on this platform that reaches for a person about the inbox.
 *
 * What is asserted here is the RESTRAINT, not the send — because the restraint is what keeps the
 * channel worth having (`critical-alert.ts` makes the argument; this inherits it). A digest that
 * mails when nothing is waiting, or counts an inquiry that has already been answered, teaches the
 * recipient to filter the sender, and then the one that mattered lands in a folder nobody opens.
 */

const HOURS_AGO = (h: number) => `now() - make_interval(hours => ${h})`;

/** The grace window is 4 hours, so a thread has to be aged past it to count. Written straight to
 *  the column: the alternative is a fake clock, and this asserts the SQL, which is where the
 *  window actually lives. */
async function ageThread(id: string, hours: number): Promise<void> {
  await query(`UPDATE admin_messages SET created_at = ${HOURS_AGO(hours)} WHERE id = $1 OR reply_to_id = $1`, [id]);
}

const guestInquiry = (content: string) => createInquiryThread({
  subject: 'דיווח על תקלה',
  content,
  party: { role: 'guest', email: 'g@x.test' },
  kind: 'fault',
});

beforeEach(async () => {
  await query('DELETE FROM admin_messages');
  vi.restoreAllMocks();
});

describe('what counts as waiting', () => {
  it('counts an unanswered inquiry, by who is waiting', async () => {
    const g = await guestInquiry('הכפתור לא עובד');
    await ageThread(g.id, 30);
    const seller = await createInquiryThread({
      subject: 'שאלה לפלטפורמה', content: 'מתי מקבלים תשלום?',
      party: { role: 'seller' }, kind: 'question',
    });
    await ageThread(seller.id, 10);

    const digest = await collectInboxDigest();
    expect(digest.total).toBe(2);
    expect(digest.waiting.guest).toBe(1);
    expect(digest.waiting.seller).toBe(1);
    expect(digest.oldestHours).toBeGreaterThanOrEqual(29);
  });

  it('stops counting one the admin has replied to', async () => {
    const g = await guestInquiry('שאלה');
    await ageThread(g.id, 30);
    expect((await collectInboxDigest()).total).toBe(1);

    await replyToAdminThread(g.id, 'admin', 'עניתי');
    expect((await collectInboxDigest()).total).toBe(0);
  });

  it('stops counting one marked handled, even with no reply', async () => {
    // Not every inquiry needs an answer — a duplicate report, or one acted on elsewhere. "Handled"
    // is the admin saying so, and the mail has to believe him or it nags about closed work.
    const g = await guestInquiry('כפילות');
    await ageThread(g.id, 30);
    await setAdminThreadStatus(g.id, true);
    expect((await collectInboxDigest()).total).toBe(0);
  });

  it('ignores one that arrived inside the grace window', async () => {
    // The whole reason the window exists: an inquiry that arrived twenty minutes before the run,
    // and may already be answered, must not produce a mail asking him to go and answer it.
    await guestInquiry('הרגע נשלח');
    expect((await collectInboxDigest()).total).toBe(0);
  });

  it('does not count a thread the ADMIN opened', async () => {
    // Those are the platform talking to a seller. Nobody is waiting on the platform for them, and
    // counting them would mean every notice he sends comes back as a mail telling him to answer it.
    const { createAdminThread } = await import('../src/lib/admin-messages.js');
    const t = await createAdminThread('11111111-1111-4111-8111-000000000001', 'הודעה', 'תוכן');
    await ageThread(t.id, 30);
    expect((await collectInboxDigest()).total).toBe(0);
  });
});

describe('the send', () => {
  it('sends nothing at all when nothing is waiting', async () => {
    const send = vi.spyOn(emailModule, 'sendEmail');
    expect(await runInboxDigest()).toBe('nothing waiting');
    expect(send).not.toHaveBeenCalled();
  });

  it('reports the count rather than sending when ALERT_EMAIL is unset', async () => {
    // The dev and CI state, and it must be visible on the job row rather than swallowed — otherwise
    // "no mail arrived" and "the feature is off" look identical from the outside.
    const send = vi.spyOn(emailModule, 'sendEmail');
    const g = await guestInquiry('משהו');
    await ageThread(g.id, 30);
    expect(await runInboxDigest()).toContain('ALERT_EMAIL not set');
    expect(send).not.toHaveBeenCalled();
  });
});
