export const prerender = false;
import type { APIRoute } from 'astro';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';
import { clientIp } from '../../lib/client-ip.js';
import { checkAuthRate, countAuthAttempt, reportRules, retryAfterMinutes } from '../../lib/rate-limit.js';
import { createPlatformInquiry } from '../../lib/platform-inquiries.js';
import { isValidEmail } from '../../lib/email-address.js';

/**
 * "דווח על תקלה" — a visitor reporting a fault or improper content to the platform.
 *
 * **Intentionally unauthenticated**, like `/api/log-client-error` beside it: the person best placed
 * to report a broken checkout is the guest whose checkout broke, and requiring an account here
 * would mean the reports that arrive are the ones from people who were already fine. CSRF still
 * applies — `middleware.ts` gates every on-demand POST — so this is reachable from our own pages
 * and not from a form on someone else's site.
 *
 * **What it will not take from the body:** which store this is about, and who the reporter is.
 * `lib/platform-inquiries.ts` derives both from the path and the session, for the reason on its
 * header. It lands as a THREAD in the Messages inbox, so the platform can answer it — until
 * 2026-08-19 it was a one-way slip on the alerts tab.
 *
 * The limiter counts ACCEPTED reports rather than rejected ones, which is the opposite of every
 * other caller of `checkAuthRate` — `rate-limit.ts#reportRules` says why.
 */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

interface ReportBody {
  kind?: unknown;
  message?: unknown;
  email?: unknown;
  pageUrl?: unknown;
  /** Which published review this complaint is about, when the reporter came from one. A review id
   *  is not a permission — it says what the complaint is ABOUT and authorises nothing, which is why
   *  it is the one identifier this endpoint does take from the body. It is stored as a foreign key,
   *  so an id naming no review lands as NULL rather than as a claim. */
  reviewId?: unknown;
}

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  const read = await readJsonBody<ReportBody>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ ok: false }, read.status);

  const rules = reportRules(clientIp(request, clientAddress));
  const gate = await checkAuthRate(rules);
  if (!gate.allowed) {
    // A number, not "try later": the person has something to say and is being asked to wait, so
    // the one useful thing to tell them is how long. The page turns it into a sentence.
    return json({ ok: false, throttled: true, retryAfterMinutes: retryAfterMinutes(gate.retryAfterSec) }, 429);
  }

  // An unusable address is DROPPED, never a reason to refuse the report — a report is worth more
  // than the way back to its author, and the form's `type="email"` already stops a real person
  // from getting here with a typo. Dropping it is also what keeps the admin panel honest: it says
  // "ללא כתובת לחזרה" rather than offering a mailto that bounces.
  const email = isValidEmail(read.value.email) ? read.value.email : null;

  const stored = await createPlatformInquiry({
    kind: read.value.kind,
    message: read.value.message,
    senderEmail: email,
    pageUrl: read.value.pageUrl,
    reviewId: read.value.reviewId,
    cookies,
  });
  // An empty message is the only "invalid" here, and the form already blocks it — so this is the
  // scripted caller, and it must not spend a slot the honest reporter would want.
  if (!stored) return json({ ok: false }, 400);

  await countAuthAttempt(rules);
  return json({ ok: true });
};
