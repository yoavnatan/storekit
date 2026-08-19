import { rows } from './db.js';
import { sendEmail } from './email/index.js';
import { renderEmailShell, esc } from './email/template.js';
import { serverEnv } from './runtime-env.js';
import { stripTrailingSlashes } from './url-base.js';
import { store } from '../config/store.config.js';
import type { InquiryParty } from './admin-messages.js';

/**
 * One mail a day, and only when somebody is waiting for an answer.
 *
 * ── Why this exists (owner, 2026-08-19) ──
 * *"כמה שפחות התעסקות שלי ושאני אקבל דיווח מבחוץ על דברים חשובים."* The inbox is a good screen and
 * it is completely silent: a guest whose checkout broke can write at 2am and sit there until
 * somebody happens to open a browser tab. Every other signal on this platform is the same shape by
 * design — the Alerts tab is a place you GO — and that is right for the hundreds of entries worth a
 * glance and nothing more. It is wrong for a person waiting on a reply.
 *
 * ── Why a digest and not a mail per inquiry ──
 * `critical-alert.ts` makes the argument this file inherits, and it is the whole reason the channel
 * is worth having: **an alert channel dies of noise, not of silence.** One bad afternoon sends forty
 * mails, the recipient makes a filter rule, and the next genuine one lands in a folder nobody opens.
 * A digest cannot do that — it is bounded at one a day no matter what arrives, and it says the same
 * thing a fresh look at the tab would say.
 *
 * ── And it stays quiet when there is nothing ──
 * No open inquiry, no mail. A daily "0 waiting" is furniture in an inbox, and furniture is what
 * teaches an eye to skip the place the real message will appear (memory
 * `feedback_no_standing_screen_prose`, applied to mail).
 *
 * ── What it deliberately does NOT report ──
 * Returns awaiting a decision. Those already reach him the moment the sweep finds them
 * (`returns-run.ts` → `alertOnCriticalError`), because money is held until he rules; repeating them
 * here would be a second mail the same day about the same thing, which is exactly how a person
 * learns that one of the two senders can be ignored.
 *
 * **Off unless `ALERT_EMAIL` is set** — the same shape and the same reason as the critical alert:
 * dev and CI stay silent without configuration, and the day the value exists in the host's settings
 * this starts delivering with nothing to change here (GO_LIVE §4).
 */

/** How long an inquiry may sit before it counts as waiting.
 *
 *  Not zero, and that is the point: an inquiry that arrived twenty minutes before the run and has
 *  already been answered should not produce a mail asking him to go and answer it. It also means a
 *  burst arriving during a working session is one line tomorrow rather than a mail today. */
const WAITING_AFTER_HOURS = 4;

export interface InboxDigest {
  /** Threads still open, unanswered, and older than the grace window — by who is waiting. */
  waiting: Record<InquiryParty, number>;
  total: number;
  /** The oldest one's age in whole hours — the number that says whether this is a queue or a
   *  backlog, and the only one that gets worse by being ignored. */
  oldestHours: number;
}

export async function collectInboxDigest(): Promise<InboxDigest> {
  // Roots only, still open, and with nothing from the admin in the thread yet — "unanswered" is the
  // question, and `read_by_admin` is not it: reading an inquiry and not replying is precisely the
  // state this mail exists to surface.
  const found = await rows<{ party_role: string | null; n: string | number; oldest_hours: string | number }>(
    `SELECT COALESCE(root.party_role, 'seller')                                  AS party_role,
            count(*)                                                             AS n,
            COALESCE(MAX(EXTRACT(EPOCH FROM (now() - root.created_at)) / 3600), 0) AS oldest_hours
       FROM admin_messages root
      WHERE root.reply_to_id IS NULL
        AND COALESCE(root.status, 'open') = 'open'
        AND root.from_role <> 'admin'
        AND root.created_at < now() - make_interval(hours => $1)
        AND NOT EXISTS (
          SELECT 1 FROM admin_messages reply
           WHERE reply.reply_to_id = root.id AND reply.from_role = 'admin'
        )
      GROUP BY 1`,
    [WAITING_AFTER_HOURS],
  );

  const waiting: Record<InquiryParty, number> = { seller: 0, buyer: 0, guest: 0 };
  let total = 0;
  let oldestHours = 0;
  for (const row of found) {
    const role = (row.party_role ?? 'seller') as InquiryParty;
    const n = Number(row.n ?? 0);
    if (role in waiting) waiting[role] += n;
    total += n;
    oldestHours = Math.max(oldestHours, Math.floor(Number(row.oldest_hours ?? 0)));
  }
  return { waiting, total, oldestHours };
}

const ROLE_WORD: Record<InquiryParty, string> = {
  seller: 'ממוכרים',
  buyer: 'מקונים',
  guest: 'מאורחים',
};

export function renderInboxDigest(digest: InboxDigest): { subject: string; html: string; text: string } {
  const base = stripTrailingSlashes(store.url ?? '');
  const link = `${base}/admin?panel=messages&mstatus=open`;
  const lines = (Object.keys(ROLE_WORD) as InquiryParty[])
    .filter((role) => digest.waiting[role] > 0)
    .map((role) => `${digest.waiting[role]} ${ROLE_WORD[role]}`);

  // The subject carries the number, because a subject that says only "פניות ממתינות" makes him open
  // the mail to learn whether it is one or forty — and the whole point of this channel is that he
  // does not have to open anything to know where he stands.
  const subject = `${digest.total} פניות ממתינות לתשובה`;
  const body = `${lines.join(' · ')}. הוותיקה ביותר ממתינה ${digest.oldestHours} שעות.`;

  const html = renderEmailShell({
    previewText: body,
    heading: subject,
    bodyHtml: `<p style="margin:0 0 1rem">${esc(body)}</p>`
      + `<p style="margin:0"><a href="${esc(link)}">${esc('פתיחת תיבת הפניות')}</a></p>`,
  });
  return { subject, html, text: `${body}\n\n${link}` };
}

/**
 * Send it, or explain in one line why nothing was sent. Never throws — it runs from the scheduler,
 * where a job that throws is a job that stops the run it is part of.
 */
export async function runInboxDigest(): Promise<string> {
  const to = serverEnv('ALERT_EMAIL');
  const digest = await collectInboxDigest();
  if (digest.total === 0) return 'nothing waiting';
  if (!to) return `${digest.total} waiting · ALERT_EMAIL not set, nothing sent`;

  const mail = renderInboxDigest(digest);
  // `replyTo` is the recipient's own address, matching `critical-alert.ts`: a reply to an automated
  // mail should land somewhere a person reads, not at a no-reply sender.
  const result = await sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text, replyTo: to });
  return result.ok ? `${digest.total} waiting · sent` : `${digest.total} waiting · send failed: ${result.error ?? 'unknown'}`;
}
