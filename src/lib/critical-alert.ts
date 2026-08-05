/**
 * The one thing in this application that reaches for a person instead of waiting to be read.
 *
 * Everything else about errors is a place you go and look: the Alerts tab records every failure with
 * its store, its actor and now its severity, and it is complete and it is quiet. That is the right
 * default for the hundreds of entries that are worth a glance and worth nothing more. It is the
 * wrong default for exactly one case — a buyer could not pay, or money and stock may now disagree —
 * because the cost of that one is measured in the hours before somebody happens to open a browser
 * tab.
 *
 * So this fires on `severity === 'critical'` and nothing else, and every design decision below
 * exists to protect that narrowness. An alert channel is only worth having while it is believed, and
 * the way these die is not silence but noise: one broken deploy sends four hundred mails, the
 * recipient makes a filter rule, and the next genuine one lands in a folder nobody opens. Everything
 * here is therefore a limit rather than a feature.
 *
 * **Off unless `ALERT_EMAIL` is set.** No address, no send, no error — dev and CI stay silent
 * without configuration, which is the same shape `email/index.ts` uses for the provider key itself.
 * Until the Resend key exists (GO_LIVE §4) a "send" is a line on the console adapter; the day the
 * key is added the same code starts delivering, with nothing to change here.
 */

import { query } from './db.js';
import { sendEmail } from './email/index.js';
import { renderEmailShell, esc } from './email/template.js';
import { serverEnv } from './runtime-env.js';
import { store } from '../config/store.config.js';
import { BUSINESS_TIMEZONE } from './business-day.js';
import { stripTrailingSlashes } from './url-base.js';

/**
 * What the alert needs, which is deliberately NOT a full `ErrorLogEntry`.
 *
 * `logError` calls this from inside the write, where the row's `id` and its `created_at` belong to
 * the database and have not come back yet. Casting the in-flight payload to a full entry would have
 * compiled and then printed "Invalid Date" in the mail — the field simply is not there. So the type
 * says what is actually available, and the timestamp is the caller's, taken at the same moment the
 * statement runs. It can differ from the stored `now()` by the width of one round trip, which is
 * not a distinction a person reading "when did this happen" can use.
 */
export interface CriticalAlertInput {
  severity?: string;
  /** The caller's clock, not the row's `created_at`. */
  createdAt: string;
  route?: string;
  message?: string;
  storeName?: string;
  actorLabel?: string;
  statusCode?: number;
}

/**
 * How long one route stays quiet after it has alerted.
 *
 * Per ROUTE rather than globally, and that is the whole point of the choice: a checkout that starts
 * failing sends one mail instead of one per buyer, while a DIFFERENT critical route failing five
 * minutes later still gets through — which is a genuinely new fact and the exact thing a blanket
 * cooldown would swallow.
 *
 * Fifteen minutes is chosen against the human, not the system: it is long enough that a storm is a
 * single notification, and short enough that a problem still unfixed an hour later says so again
 * rather than being reported once and forgotten.
 */
const ROUTE_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * A ceiling across all routes, per process, per hour — the second layer, and it exists because the
 * first one is keyed on something an attacker or a bad loop can vary. A path with a `/:id` in it,
 * or a burst walking many routes at once, would slip past a per-route window one mail at a time;
 * this bounds the whole channel no matter how the failures are spread.
 *
 * In process rather than in the database: it is a property of this instance's mail sending, it must
 * hold even when the dedup query below fails, and it must cost nothing to check.
 */
const MAX_ALERTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

let hourStart = 0;
let sentThisHour = 0;

/** Test seam — module state, and a test asserting the ceiling must not inherit the previous one's. */
export function resetAlertBudget(): void {
  hourStart = 0;
  sentThisHour = 0;
}

function withinHourlyBudget(): boolean {
  const now = Date.now();
  if (now - hourStart >= HOUR_MS) {
    hourStart = now;
    sentThisHour = 0;
  }
  if (sentThisHour >= MAX_ALERTS_PER_HOUR) return false;
  sentThisHour++;
  return true;
}

/** Where the alert goes. Absent is the normal state in dev and CI, and it switches the whole
 *  module off rather than failing. */
export function alertRecipient(): string | undefined {
  return serverEnv('ALERT_EMAIL');
}

/**
 * Has this route already alerted inside the cooldown?
 *
 * Derived from `error_log` itself rather than from a table of its own, which is what keeps this
 * feature to zero new schema. The reasoning: a critical entry is written before this runs, so
 * "were there OTHER critical entries on this route in the window" answers "did we already tell
 * somebody" for every case that matters. It reads `error_log_severity_idx` (migrations/0013).
 *
 * Two honest limitations, stated rather than hidden. Two writers landing in the same instant can
 * both see a count of one and both send — the worst case is two mails, not four hundred, and paying
 * for a lock to prevent it would be worse than the problem. And an entry evicted by the 500-row
 * ceiling stops counting, which under a storm makes the window effectively shorter — but a storm is
 * precisely when the hourly ceiling above takes over.
 *
 * On a query failure it returns `true` — SUPPRESS. When the database is unwell the wrong direction
 * to fail is the one that mails.
 */
async function alreadyAlertedForRoute(route: string | undefined, sinceMs: number): Promise<boolean> {
  try {
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM error_log
        WHERE severity = 'critical'
          AND created_at > now() - ($2::int * interval '1 millisecond')
          AND route IS NOT DISTINCT FROM $1`,
      [route ?? null, sinceMs],
    );
    // `> 1`, not `> 0`: the entry that triggered this call is itself in the count.
    return (rows[0]?.n ?? 0) > 1;
  } catch {
    return true;
  }
}

/** A subject line that cannot carry a header break, whatever the route turned out to contain.
 *  Collapses every control character to a space and bounds the length — a mail client truncates a
 *  long subject anyway, and a bounded one cannot be used to push anything past a parser. */
function subjectSafe(value: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters IS the check here
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200);
}

function renderAlertEmail(entry: CriticalAlertInput): { subject: string; html: string; text: string } {
  const when = new Date(entry.createdAt).toLocaleString('he-IL', { timeZone: BUSINESS_TIMEZONE });
  const route = entry.route ?? '—';
  const adminUrl = `${stripTrailingSlashes(store.url)}/admin?panel=alerts`;

  // The subject carries the route, because a phone shows the subject and nothing else, and "where"
  // is the one word that decides whether this is worth opening now.
  //
  // `subjectSafe` because a subject is a HEADER, not a body: `esc()` is the wrong tool and a raw
  // CR/LF is the right worry. Not reachable today — a route reaches this only from `middleware.ts`,
  // where it is a parsed `URL.pathname` and cannot hold a control character, and the one route
  // field an outsider does supply (`/api/log-client-error`, a plain JSON string that CAN hold
  // "\r\nBcc:") is `source: 'client'`, which `error-severity.ts` makes a warning, which never
  // arrives here. That is two independent accidents away from header injection, and both are
  // decisions in other files that could be revisited by someone who never reads this one. The
  // current provider is also a JSON API rather than SMTP, so the injection has nowhere to land —
  // which is itself a fact about `resend-adapter.ts`, not about this line.
  const subject = subjectSafe(`[${store.name}] שגיאה קריטית — ${route}`);

  const rows: [string, string][] = [
    ['מתי', when],
    ['נתיב', route],
    ['הודעה', entry.message ?? '—'],
    ...(entry.storeName ? ([['חנות', entry.storeName]] as [string, string][]) : []),
    ...(entry.actorLabel ? ([['משתמש', entry.actorLabel]] as [string, string][]) : []),
    ...(entry.statusCode ? ([['סטטוס', String(entry.statusCode)]] as [string, string][]) : []),
  ];

  const bodyHtml = `
    <p style="margin:0 0 16px">נרשמה שגיאה בדרגת חומרה <strong>קריטית</strong> — כלומר קונה לא הצליח
    להשלים רכישה, או שנתוני כסף/מלאי עלולים להיות לא נכונים.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">
      ${rows.map(([label, value]) => `
        <tr>
          <td style="padding:6px 0;color:#666;white-space:nowrap;vertical-align:top">${esc(label)}</td>
          <td style="padding:6px 0 6px 12px;word-break:break-word">${esc(value)}</td>
        </tr>`).join('')}
    </table>
    <p style="margin:20px 0 0"><a href="${esc(adminUrl)}">פתיחת לשונית ההתראות</a></p>
    <p style="margin:16px 0 0;font-size:13px;color:#666">שגיאות נוספות באותו נתיב לא ישלחו מייל
    ב-15 הדקות הקרובות — הרשימה המלאה תמיד בלשונית.</p>`;

  const text = [
    'שגיאה קריטית',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    adminUrl,
  ].join('\n');

  return {
    subject,
    html: renderEmailShell({ previewText: `${route} — ${entry.message ?? ''}`.slice(0, 120), heading: 'שגיאה קריטית', bodyHtml }),
    text,
  };
}

/**
 * Send the alert if this entry deserves one. Never throws, never rejects, meant to be `void`ed.
 *
 * **It must not call `logError`, at any point, for any reason.** This runs from inside `logError`,
 * so reporting its own failure through the same door is a loop — and the loop would be entered
 * exactly when things are already going wrong. `console.error` is the whole error handling here, and
 * it is deliberate: stderr is where the host keeps logs and where a log drain would read.
 */
export async function alertOnCriticalError(entry: CriticalAlertInput): Promise<void> {
  try {
    if (entry.severity !== 'critical') return;
    const to = alertRecipient();
    if (!to) return;
    if (!withinHourlyBudget()) {
      console.error('[critical-alert] suppressed (hourly ceiling):', entry.route, entry.message);
      return;
    }
    if (await alreadyAlertedForRoute(entry.route, ROUTE_COOLDOWN_MS)) return;

    const { subject, html, text } = renderAlertEmail(entry);
    const result = await sendEmail({ to, subject, html, text });
    if (!result.ok) {
      console.error('[critical-alert] send failed:', result.error, '|', entry.route, entry.message);
    }
  } catch (err) {
    console.error('[critical-alert] failed:', err instanceof Error ? err.message : String(err));
  }
}
