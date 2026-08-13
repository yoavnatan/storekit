export const prerender = false;
import type { APIRoute } from 'astro';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';
import { clientIp } from '../../lib/client-ip.js';
import { checkAuthRate, countAuthAttempt, reportRules, retryAfterMinutes } from '../../lib/rate-limit.js';
import { createUserReport } from '../../lib/user-reports.js';
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
 * `lib/user-reports.ts` derives both from the path and the session, for the reason on its header.
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

  const stored = await createUserReport({
    kind: read.value.kind,
    message: read.value.message,
    reporterEmail: email,
    pageUrl: read.value.pageUrl,
    userAgent: request.headers.get('user-agent'),
    cookies,
  });
  // An empty message is the only "invalid" here, and the form already blocks it — so this is the
  // scripted caller, and it must not spend a slot the honest reporter would want.
  if (!stored) return json({ ok: false }, 400);

  await countAuthAttempt(rules);
  return json({ ok: true });
};
