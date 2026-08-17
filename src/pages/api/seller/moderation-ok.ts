export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { clearModerationMissingReports, moderationDeclaredOn } from '../../../lib/image-moderation-health.js';

/**
 * **"An upload just came back judged"** — the one signal that can turn the image-filter alarm off.
 *
 * Its twin is `/api/log-client-error`, which the browser calls when an upload comes back with NO
 * verdict. That report is what raises the admin's "סינון התמונות נעצר" card. This is the other
 * direction, and the reason it had to exist: the card knew about failures only, so nothing could
 * ever clear it except a person clicking "סמן כטופל" or the report ageing out three weeks later
 * (owner, 2026-08-17: *"הוא לא יתעדכן אוטומטית בשום מצב?!"*).
 *
 * **Authenticated, unlike its twin, and the asymmetry is deliberate.** Reporting a fault is
 * something any page may do — the worst a liar achieves is a false alarm, which is the safe
 * direction. Reporting HEALTH resolves an existing alarm, so it is gated on a seller session: the
 * only place an upload happens is the seller's own dashboard, so nothing legitimate is turned away,
 * and an anonymous visitor cannot reach in and dismiss a warning about the platform.
 *
 * Even past that gate the blast radius is one dismissal of a report about a condition that has
 * stopped being true: `clearModerationMissingReports` touches only rows that exist now, and the next
 * unjudged upload writes a fresh one. A seller cannot silence the filter, only close a stale note
 * about it — see that function's header.
 *
 * No body, no parameters, nothing to validate: the request IS the claim, and the only fact it
 * carries is "this happened". Nothing here trusts a number the client chose.
 */
export const POST: APIRoute = async ({ cookies }) => {
  // Nothing was ever declared, so there is no alarm of this kind to clear and no reason to write.
  if (!moderationDeclaredOn()) return new Response(null, { status: 204 });

  if (!getSellerSession(cookies)) return new Response(null, { status: 401 });

  await clearModerationMissingReports();
  // 204 either way. The browser fires this and forgets — it has nothing to do with the answer, and
  // a count would only invite a caller to care about it.
  return new Response(null, { status: 204 });
};
