// Store-lifecycle emails — the seller-facing confirmation of a state they just put their own
// store into (lib/store-status.ts): paused, closing, or closed.
//
// Why mail at all, when the seller was looking at the dashboard when they clicked: because two of
// the three states have consequences that are NOT visible on that screen and outlive the session.
// Pausing takes the store out of the mall, out of search, out of the ad feed and stops every
// running boost — a seller who sees only "החנות מוקפאת" does not know that. And a closure with
// open orders does not happen when they press the button; it happens later, on its own, once
// they have finished the parcels they still owe. That obligation has to arrive somewhere they
// will still have it tomorrow.
//
// The open-order count is the point of the whole message, so it is stated as a number and as an
// obligation, never as a footnote. Deliberately the SAME number the dashboard and the admin show
// (store-lifecycle.ts#openOrderCount) — one definition of "still owed", three surfaces.
//
// buildStoreLifecycleEmail is PURE (unit-testable); sendStoreLifecycleEmail is the thin resilient
// wrapper — mail must never be able to break the state change that triggered it.

import { store as platform } from '../../config/store.config.js';
import type { Store } from '../stores.js';
import { logError } from '../error-log.js';
import type { EmailMessage } from './adapter.js';
import { renderEmailShell, esc } from './template.js';
import { SITE, ctaButton } from './parts.js';
import { sendEmail } from './index.js';

/** The four states worth a letter. `blocked` is not one — an admin block has its own notice and
 *  its own appeal thread (api/admin/moderation.ts), and a second unrelated mail would only muddy
 *  which channel to answer on.
 *
 *  `active` (reopening) was left out at first as "it only restores what the seller already knows",
 *  and that was wrong (user, 2026-07-31): coming back is NOT symmetrical with pausing. The
 *  storefront returns by itself, but the boost campaigns do not — the platform stopped them
 *  because there was nothing to advertise, and ad-campaign-health.ts refuses to restart spend
 *  without a person deciding to. A seller who reopens and assumes their ads came back with it
 *  loses days of advertising and never sees a message saying so. That is the letter. */
export type LifecycleMailState = 'paused' | 'closing' | 'closed' | 'active';

/** `unpublished` is deliberately not one either, and it is the reason this guard exists: every
 *  letter above is about a LIVE shop going away or coming back, and a shop that has never been
 *  public has neither happened to it. What a waiting seller is told — what is missing and that
 *  nothing is his fault — is `store-publication.ts`'s, on the screen where the next step is.
 *  A guard rather than a cast, so adding a sixth lifecycle state forces the same decision again. */
export function isLifecycleMailState(state: string): state is LifecycleMailState {
  return state === 'paused' || state === 'closing' || state === 'closed' || state === 'active';
}

const DASHBOARD = `${SITE}/seller/dashboard?panel=settings`;
const ORDERS = `${SITE}/seller/dashboard?panel=orders`;
const ADVERTISING = `${SITE}/seller/dashboard?panel=advertising`;

/** What pausing actually does, spelled out — the half the seller cannot see from the button. */
const PAUSE_EFFECTS = [
  'החנות לא מקבלת הזמנות חדשות.',
  'החנות הוסרה מדף הבית, מהחיפוש ומהפיד לפרסום.',
  'קמפיינים פעילים נעצרו. הנתונים שנצברו בהם נשמרו במלואם.',
  'דף החנות עצמו נשאר פעיל ומציג הודעה לקונים — כדי לא לאבד את הדירוג בגוגל שנצבר.',
  'שום נתון לא נמחק: ההזמנות, ההכנסות והדוחות נשארים כפי שהם.',
];

/** One state's message, as CONTENT rather than as markup — the HTML body and the plain-text body
 *  are then both rendered from it, and neither can carry a sentence the other lacks.
 *
 *  It was written the other way first: HTML per state, and a separate hand-built list of text
 *  lines. The closure mail's HTML said "ההזמנות וההכנסות נשמרו במלואם" and its text part said
 *  nothing at all — the single most reassuring line in the whole message, missing from the copy a
 *  text-only client shows, and invisible to every test because both parts were being searched
 *  together. Found by rendering the four mails and reading them. */
interface StateCopy {
  subject: string;
  heading: string;
  intro: (storeName: string) => string;
  /** The bullet list: `<li>` in HTML, "- " lines in text. */
  lines: string[];
  /** The closing paragraph after the bullets and the open-order block. `strong` marks the run to
   *  bold in HTML; the text part simply drops the markers. */
  note: string;
  cta?: { href: string; label: string };
}

/** `**…**` is the only markup a note may carry — bolded in HTML, stripped for text. */
function renderNote(note: string): string {
  return `<p style="margin:0 0 12px;">${esc(note).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`;
}

function plainNote(note: string): string {
  return note.replace(/\*\*/g, '');
}

function bullets(lines: string[]): string {
  return `<ul style="margin:0 0 12px;padding-inline-start:18px;">${
    lines.map((l) => `<li style="margin:0 0 6px;">${esc(l)}</li>`).join('')
  }</ul>`;
}

/** The obligation sentence. Empty when nothing is owed, so a seller with a clean slate is never
 *  told to go and handle nothing. One function for both bodies — this is the sentence that must
 *  never be the one that goes missing. */
function openOrdersSentence(openOrders: number, state: LifecycleMailState): string {
  if (openOrders <= 0 || (state !== 'paused' && state !== 'closing')) return '';
  const count = openOrders === 1 ? 'הזמנה פתוחה אחת' : `${openOrders} הזמנות פתוחות`;
  return state === 'closing'
    ? `יש לך ${count} שטרם הושלמו. **חובה לסיים את הטיפול בהן לפני שהחנות תיסגר** — קונה ששילם זכאי לקבל את ההזמנה שלו. החנות תיסגר לבד ברגע שההזמנה הפתוחה האחרונה תסומן כנמסרה או תבוטל, ואין צורך לחזור ולאשר שוב.`
    : `יש לך ${count}. ההקפאה לא משנה בהן דבר — **הן עדיין באחריותך והדשבורד פתוח כרגיל** לטיפול בהן: עדכון סטטוס, מספר מעקב והודעות לקונים ממשיכים לעבוד בדיוק כמו קודם.`;
}

const COPY: Record<LifecycleMailState, StateCopy> = {
  paused: {
    subject: 'החנות הוקפאה',
    heading: 'החנות הוקפאה',
    intro: (name) => `הקפאת את "${name}". זה מה שקורה עכשיו:`,
    lines: PAUSE_EFFECTS,
    note: 'אפשר להחזיר את החנות לפעילות בכל רגע, בלחיצה אחת, והכל חוזר בדיוק כפי שהיה.',
    cta: { href: DASHBOARD, label: 'להחזרת החנות לפעילות' },
  },
  closing: {
    subject: 'בקשת סגירת החנות התקבלה',
    heading: 'בקשת סגירת החנות התקבלה',
    intro: (name) => `ביקשת לסגור את "${name}". המכירות כבר נעצרו, אבל הסגירה עצמה עוד לא הושלמה:`,
    lines: PAUSE_EFFECTS,
    note: 'כל עוד הסגירה לא הושלמה אפשר לבטל אותה, והחנות תחזור לפעילות מלאה.',
    cta: { href: DASHBOARD, label: 'לביטול הסגירה' },
  },
  active: {
    subject: 'החנות חזרה לפעילות',
    heading: 'החנות חזרה לפעילות',
    intro: (name) => `"${name}" חזרה לפעילות מלאה.`,
    lines: [
      'החנות מקבלת הזמנות שוב.',
      'היא חזרה לדף הבית, לחיפוש ולפיד לפרסום — ההופעה בגוגל מתעדכנת מעצמה תוך זמן קצר.',
    ],
    note: '**שים לב: קמפיינים שנעצרו בזמן ההקפאה לא חוזרים לבד.** עצרנו אותם כדי לא להמשיך לשלם על פרסום לחנות שלא מוכרת, ואנחנו לא מחדשים הוצאה כספית בלי שתחליט על כך. הנתונים שנצברו בהם נשמרו — צריך רק להפעיל אותם מחדש בלשונית הפרסום.',
    cta: { href: ADVERTISING, label: 'ללשונית הפרסום' },
  },
  closed: {
    subject: 'החנות נסגרה',
    heading: 'החנות נסגרה',
    intro: (name) => `"${name}" נסגרה ואינה מופיעה יותר באתר.`,
    lines: [
      'החנות ירדה מהאתר: קישור ישיר אליה כבר לא מציג אותה.',
      'הקמפיינים שלה נסגרו והועברו להיסטוריה, יחד עם כל הנתונים שנצברו בהם.',
      'ההזמנות, ההכנסות והדוחות ההיסטוריים נשמרו במלואם — שום נתון לא נמחק.',
    ],
    note: 'תודה על השותפות. אם תרצה לפתוח חנות חדשה בעתיד, החשבון שלך נשאר פעיל.',
  },
};

export interface LifecycleEmailInput {
  to: string;
  sellerName: string;
  store: Pick<Store, 'name'>;
  state: LifecycleMailState;
  /** Orders the store still owes something on, at the moment of the change. */
  openOrders: number;
}

export function buildStoreLifecycleEmail(input: LifecycleEmailInput): EmailMessage | null {
  const copy = COPY[input.state];
  if (!copy || !input.to) return null;

  const duty = openOrdersSentence(input.openOrders, input.state);

  const bodyHtml = `
<p style="margin:0 0 12px;">שלום ${esc(input.sellerName)},</p>
<p style="margin:0 0 12px;">${esc(copy.intro(input.store.name))}</p>
${bullets(copy.lines)}
${duty ? `${renderNote(duty)}${ctaButton(ORDERS, 'למסך ההזמנות')}` : ''}
${renderNote(copy.note)}
${copy.cta ? ctaButton(copy.cta.href, copy.cta.label) : ''}`;

  return {
    to: input.to,
    subject: `${copy.subject} · ${input.store.name}`,
    html: renderEmailShell({ previewText: `${copy.subject} — ${input.store.name}`, heading: copy.heading, bodyHtml }),
    // Built from the SAME copy object as the HTML above, not from a parallel list — that is what
    // stops one body from carrying a sentence the other lost (see StateCopy).
    text: [
      `שלום ${input.sellerName},`,
      copy.intro(input.store.name),
      ...copy.lines.map((l) => `- ${l}`),
      ...(duty ? [plainNote(duty)] : []),
      plainNote(copy.note),
      '',
      platform.name,
    ].join('\n'),
  };
}

/** Side-effecting entry point — call AFTER the state change is persisted. Never throws: the state
 *  change is the fact, the mail is a notification about it, and losing the second must never undo
 *  the first. A failure is logged with a hint, because the `closing` mail carries an obligation
 *  the seller would otherwise only ever see if they happened to reopen the dashboard. */
export async function sendStoreLifecycleEmail(input: LifecycleEmailInput): Promise<void> {
  try {
    const email = buildStoreLifecycleEmail(input);
    if (!email) return;
    const res = await sendEmail(email);
    if (!res.ok) {
      void logError({
        source: 'server',
        route: '/api/seller/store-lifecycle',
        message: `Store-lifecycle email (${input.state}) failed: ${res.error ?? 'unknown'}`,
        statusCode: 502,
        actorRole: 'seller',
        actorLabel: input.to,
        resolutionHint: 'מצב החנות עודכן תקין, אבל המוכר לא קיבל מייל שמסביר מה קרה (ובמצב "לקראת סגירה" — כמה הזמנות פתוחות נותרו לו). לבדוק את מודול המייל.',
      });
    }
  } catch (err) {
    void logError({
      source: 'server',
      route: '/api/seller/store-lifecycle',
      message: `Store-lifecycle email threw: ${String(err)}`,
      statusCode: 500,
      actorRole: 'seller',
      actorLabel: input.to,
      resolutionHint: 'מצב החנות עודכן תקין; המייל למוכר נכשל.',
    });
  }
}
