// "Your shop is live" — the one letter this platform owed and did not send.
//
// ── Why a notification was never enough (owner, 2026-08-25) ──
// *"האם בסוף נשלחת רק התראה או גם מייל?"* — and the answer was only a notification. That is the
// wrong channel for this specific event and for a reason the flow itself creates: publication is
// DERIVED and nobody presses it (`store-publication.ts`), and the last hold to lift is usually
// PayMe's approval, which takes up to seven business days. So the moment a seller has been waiting
// for arrives on a day he is not looking, and a red dot on a dashboard he has not opened is a
// message to nobody. The whole build-free-pay-to-publish bet ends here; ending it in silence is
// how a seller who paid drifts away without ever seeing what he bought.
//
// It is also the first charge. The card is taken in the same pass that puts the shop up
// (`subscription-arm.ts`), so this is the first money that has ever left his card for us — and a
// charge nobody announced is the one a person disputes.
//
// ── What it does NOT do ──
// It does not congratulate, and it does not list features. It says the shop is on the site, names
// where, says what was charged, and stops. The seller has been waiting a week for one fact.
//
// `buildStoreLiveEmail` is PURE (unit-testable); `sendStoreLiveEmail` is the thin resilient
// wrapper — mail must never be able to undo a publication that already happened.

import { logError } from '../error-log.js';
import type { EmailMessage } from './adapter.js';
import { renderEmailShell, esc } from './template.js';
import { SITE, ctaButton, storefrontUrl } from './parts.js';
import { sendEmail } from './index.js';
import { formatAgorot } from '../money.js';

export interface StoreLiveEmailInput {
  to: string;
  storeName: string;
  storeSlug: string;
  /** What the standing order charged in the same pass, in agorot. Absent when nothing was charged
   *  here — a shop going live on a subscription that was already running, which is the second-shop
   *  case. The letter then simply does not mention money, because none moved today. */
  chargedAgorot?: number;
}

/** Pure: no I/O, so the wording is testable without a mail adapter. */
export function buildStoreLiveEmail(input: StoreLiveEmailInput): EmailMessage {
  const url = storefrontUrl(input.storeSlug);
  const charged = input.chargedAgorot && input.chargedAgorot > 0
    ? `<p style="margin:0 0 14px">החיוב החודשי הראשון בסך <strong>${esc(formatAgorot(input.chargedAgorot))}</strong> בוצע היום, ויתחדש כל חודש. אפשר לבטל בכל רגע מלשונית התשלומים — החנות נשארת באוויר עד סוף התקופה ששולמה.</p>`
    : '';

  const body = `
    <p style="margin:0 0 14px">שלום,</p>
    <p style="margin:0 0 14px"><strong>${esc(input.storeName)}</strong> באוויר.</p>
    <p style="margin:0 0 14px">מהרגע הזה החנות מופיעה במתחם, בחיפוש ובגוגל, ואפשר לקנות בה.</p>
    ${charged}
    ${ctaButton(url, 'לצפייה בחנות')}
    <p style="margin:14px 0 0;color:#6b7280;font-size:13px">${esc(url.replace(/^https?:\/\//, ''))}</p>
  `;

  // The plain-text half is not a courtesy: `EmailMessage` requires it, for the clients that do not
  // render HTML and for deliverability. Same three facts, in the same order.
  const text = [
    `${input.storeName} באוויר.`,
    'מהרגע הזה החנות מופיעה במתחם, בחיפוש ובגוגל, ואפשר לקנות בה.',
    input.chargedAgorot && input.chargedAgorot > 0
      ? `החיוב החודשי הראשון בסך ${formatAgorot(input.chargedAgorot)} בוצע היום, ויתחדש כל חודש. אפשר לבטל בכל רגע מלשונית התשלומים.`
      : '',
    url,
  ].filter(Boolean).join('\n\n');

  return {
    to: input.to,
    subject: `${input.storeName} באוויר`,
    html: renderEmailShell({
      previewText: `${input.storeName} מופיעה עכשיו במתחם, בחיפוש ובגוגל.`,
      heading: `${input.storeName} באוויר`,
      bodyHtml: body,
    }),
    text,
  };
}

export async function sendStoreLiveEmail(input: StoreLiveEmailInput): Promise<void> {
  try {
    const res = await sendEmail(buildStoreLiveEmail(input));
    if (!res.ok) {
      void logError({
        source: 'server',
        route: 'store-publication',
        message: `Store-live email failed for ${input.storeSlug}: ${res.error ?? 'unknown'}`,
        statusCode: 502,
        actorRole: 'seller',
        actorLabel: input.to,
        resolutionHint: 'החנות עלתה לאוויר תקין, אבל המוכר לא קיבל על כך מייל — וזה הרגע שהוא חיכה לו שבוע, אולי ביום שהוא לא נכנס לדשבורד. לבדוק את מודול המייל.',
      });
    }
  } catch (err) {
    void logError({
      source: 'server',
      route: 'store-publication',
      message: `Store-live email threw for ${input.storeSlug}: ${String(err)}`,
      statusCode: 500,
      actorRole: 'seller',
      actorLabel: input.to,
      resolutionHint: 'החנות באוויר; המייל למוכר נכשל.',
    });
  }
}

/** Re-exported so `SITE` stays one definition across the mail modules. */
export { SITE };
