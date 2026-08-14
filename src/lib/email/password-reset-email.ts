// The forgot-password letter — the only mail on the platform that is itself a credential.
//
// Two things follow from that and shape the copy below.
//
// **It has to say what to do if you did not ask for it.** Someone else typing your address into the
// form is the ordinary case, not the alarming one, and a mail that does not say so reads as "your
// account has been attacked". The honest sentence is short: ignore it, nothing changed, the link
// dies on its own. Deliberately with no "was this you? / no it wasn't" button — a one-click report
// on an unauthenticated mail is a second thing an attacker can make a stranger click.
//
// **It states the lifetime as a fact, in the body.** A link that has quietly stopped working is the
// most common way this flow fails a person, and "לשעה הקרובה" turns a dead link from a broken site
// into an expected outcome with an obvious remedy.
//
// The URL carries the token, so nothing here may be logged and the mail carries no tracking pixel,
// no shortener and no redirect hop — every one of those is somewhere the token would also arrive.
//
// buildPasswordResetEmail is PURE; sendPasswordResetEmail is the resilient wrapper.

import { store } from '../../config/store.config.js';
import { logError } from '../error-log.js';
import type { EmailMessage } from './adapter.js';
import { renderEmailShell, esc, emailColors as C } from './template.js';
import { ctaButton } from './parts.js';
import { sendEmail } from './index.js';

export interface PasswordResetEmailInput {
  to: string;
  sellerName: string;
  /** Absolute, single-use, and the reason this mail is a credential. */
  resetUrl: string;
  expiresInMinutes: number;
}

export function buildPasswordResetEmail(input: PasswordResetEmailInput): EmailMessage | null {
  if (!input.to || !input.resetUrl) return null;

  const bodyHtml = `
<p style="margin:0 0 12px;">שלום ${esc(input.sellerName)},</p>
<p style="margin:0 0 12px;">קיבלנו בקשה לאיפוס הסיסמה שלך ב-${esc(store.name)}. לבחירת סיסמה חדשה:</p>
${ctaButton(input.resetUrl, 'לבחירת סיסמה חדשה')}
<p style="margin:20px 0 0;color:${C.muted};font-size:13px;line-height:1.6;">
הקישור תקף ל-${input.expiresInMinutes} הדקות הקרובות ולשימוש אחד בלבד. אחרי שתשתמש בו הוא מפסיק לעבוד.
</p>
<p style="margin:10px 0 0;color:${C.muted};font-size:13px;line-height:1.6;">
<strong style="color:${C.text};">לא ביקשת לאפס סיסמה?</strong> אפשר להתעלם מהמייל הזה. הסיסמה שלך לא השתנתה, ואף אחד לא יכול לשנות אותה בלי הקישור שכאן.
</p>
<p style="margin:10px 0 0;color:${C.muted};font-size:12px;line-height:1.6;word-break:break-all;">
אם הכפתור לא עובד, אפשר להעתיק את הכתובת הזאת לדפדפן:<br>
<span dir="ltr">${esc(input.resetUrl)}</span>
</p>`;

  return {
    to: input.to,
    subject: `איפוס סיסמה · ${store.name}`,
    html: renderEmailShell({
      previewText: `קישור לבחירת סיסמה חדשה, תקף ל-${input.expiresInMinutes} דקות`,
      heading: 'איפוס סיסמה',
      bodyHtml,
    }),
    text: [
      `שלום ${input.sellerName},`,
      `קיבלנו בקשה לאיפוס הסיסמה שלך ב-${store.name}.`,
      '',
      'לבחירת סיסמה חדשה:',
      input.resetUrl,
      '',
      `הקישור תקף ל-${input.expiresInMinutes} הדקות הקרובות ולשימוש אחד בלבד.`,
      'לא ביקשת לאפס סיסמה? אפשר להתעלם מהמייל הזה — הסיסמה שלך לא השתנתה.',
      '',
      store.name,
    ].join('\n'),
  };
}

/**
 * Side-effecting entry point. Never throws — and the caller must `void` it rather than await it, so
 * that a slow provider cannot make the "אם הכתובת רשומה, שלחנו קישור" page take measurably longer
 * for a registered address than for an unregistered one (`lib/password-reset.ts` header).
 */
export async function sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
  try {
    const email = buildPasswordResetEmail(input);
    if (!email) return;
    const res = await sendEmail(email);
    if (!res.ok) {
      void logError({
        source: 'server',
        route: '/seller/forgot-password',
        // The URL is the credential — the address is as much as may ever be written down about it.
        message: `Password-reset email failed: ${res.error ?? 'unknown'}`,
        statusCode: 502,
        actorRole: 'seller',
        actorLabel: input.to,
        resolutionHint: 'מוכר ביקש לאפס סיסמה ולא קיבל מייל — הוא נעול מחוץ לחשבון עד שזה ייפתר. לבדוק את מודול המייל.',
      });
    }
  } catch (err) {
    void logError({
      source: 'server',
      route: '/seller/forgot-password',
      message: `Password-reset email threw: ${err instanceof Error ? err.message : String(err)}`,
      stack: err instanceof Error ? err.stack : undefined,
      statusCode: 500,
      actorRole: 'seller',
      actorLabel: input.to,
      resolutionHint: 'מוכר ביקש לאפס סיסמה ולא קיבל מייל.',
    });
  }
}
