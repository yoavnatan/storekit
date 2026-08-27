/**
 * Who may CHANGE things on the portfolio demonstration, and who may only look.
 *
 * ── The problem this exists for ─────────────────────────────────────────────
 *
 * The demonstration hands out two sessions to anybody who presses a button: the seller account that
 * owns the four showcase shops, and an admin session. Both are real sessions against a real
 * application, so until this file existed a visitor could — with no password and no warning —
 *
 *   close or pause a shop, which takes it off the site entirely;
 *   delete any of the 412 products, or bulk-delete all of them;
 *   rewrite the store's name, slogan, images and custom domain;
 *   cancel the subscription, which un-publishes every shop behind it;
 *   block a store or a product from the admin, hide a review, delete a conversation;
 *   clear the whole error log;
 *   resolve a returns dispute and award a refund out of a seller's money;
 *   rewrite the seller's bank details and ID number.
 *
 * Any one of those ends the demonstration for everybody who follows, and the owner would find out
 * by opening his own link. An hourly rebuild used to cover it, and it had to be turned off for a
 * better reason: the showcase shops are edited THROUGH the dashboard, so a rebuild every hour threw
 * away the owner's own work (`jobs/registry.ts`).
 *
 * ── The rule, and why it is this shape ──────────────────────────────────────
 *
 * **A shared demo session may read everything, and may write only the short list below.**
 *
 * The list is an ALLOW-list, and that is the whole design. The first version of this file was a
 * deny-list — refuse `/api/admin/*` and `/api/seller/*` — and it was already wrong on the day it
 * was written, which is what makes the point rather than an argument for it. A seller's real write
 * surface is 41 routes and only nine of them live under `/api/seller/`: the showcase shops' products
 * are edited through `/api/store-product/*`, the shop record itself through `/api/store`, and a
 * returns dispute — real money, awarded to one side — through `/api/returns`, which is an admin
 * power sitting at a path with no `admin` in it. A deny-list has to be right about a surface nobody
 * has finished enumerating, and it is wrong SILENTLY, which is how it passed a live drive against
 * three `/api/seller/` paths that do not exist.
 *
 * Inverted, the same rule cannot rot. A route added next month is refused by default, and the
 * failure direction is that the demonstration refuses something harmless — visible immediately, to
 * the owner, with a friendly sentence — rather than that a stranger deletes the exhibit.
 *
 * What the list therefore keeps, and why each entry is on it:
 *
 *   · **The doors.** `/admin/login` above all: the owner's password login is how a viewer session
 *     becomes an owner session, so refusing it would lock the owner out of his own demonstration
 *     with a rule written to protect it. Register and the password-reset pages, likewise — somebody
 *     who presses "פתח חנות" gets an account and a shop of their OWN, and is an ordinary seller in
 *     it, which is the second flow worth showing.
 *   · **Shopping.** Browsing, the cart, and completing a purchase. A visitor buying something is the
 *     flow the demonstration is FOR, and it writes only rows belonging to that purchase.
 *   · **Plumbing** that describes the visitor rather than the exhibit: language, analytics, a
 *     client-error report.
 *
 * Everything else — including writing a review, marking the exhibit's notifications read, and every
 * dashboard save on either side — is refused for the two shared accounts only. A visitor with an
 * account of their own is untouched by all of it.
 *
 * **And so is the owner, on every path, including the shared account's own dashboard.** That is not
 * an exception bolted on: editing the showcase shops through the dashboard is why the hourly
 * rebuild was turned off, and doing it means holding a session for the very account this rule
 * recognises and refuses. His password at `/admin/login` is what tells the two apart, and it is the
 * only thing that does.
 *
 * ── Where it is enforced ────────────────────────────────────────────────────
 *
 * `middleware.ts`, immediately after the CSRF gate — the same argument that file makes for the
 * token: one place, before the request costs a database lookup, and impossible to route around.
 */
import type { APIContext } from 'astro';
import { isDemoMode, isSharedDemoAccount } from './demo-mode.js';
import { adminRole } from './admin-auth.js';
import { getSellerSession, getSellerById } from './seller-auth.js';

/** Methods that can change something. HEAD/GET/OPTIONS never reach the checks below. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The only paths a shared demo session may write to. Exported so a test can assert the module's
 * answer matches this list exactly, rather than re-describing it and drifting.
 *
 * Exact paths, not prefixes: a prefix is how the deny-list this replaced went wrong, and every
 * entry here is one route somebody thought about.
 */
export const DEMO_WRITE_ALLOWED: ReadonlySet<string> = new Set([
  // The doors, IN AND OUT. `/admin/login` is how the OWNER stops being a viewer — refusing it
  // locks him out. `/seller/logout` is a POST, so the allow-list had to name it and did not: a
  // visitor who took the tour could not leave it, and the sign-out button answered "this is a
  // demonstration" with no way to act on that (owner, 2026-08-27). Logging out is the one write
  // that can never damage anything — it removes the caller's own cookie and touches no row.
  // `/admin/logout` is a GET and was never refused; it is named anyway, so the pair is visible
  // together and a future change of method does not silently break one of them.
  '/admin/login',
  '/admin/logout',
  '/seller/login',
  '/seller/logout',
  '/seller/register',
  '/seller/forgot-password',
  '/seller/reset-password',

  // Shopping — the flow the demonstration exists to show.
  '/api/checkout',
  '/api/user-cart',
  '/api/cart/coupon',
  '/api/cart/prices',
  '/api/favorite-store',

  // Plumbing that records the visitor, not the exhibit.
  '/api/lang',
  '/api/analytics/event',
  '/api/log-client-error',
  '/api/report',
  '/api/payme/callback',

  // Records that an admin tab was opened, which is what clears its own "(N)" badge. Refusing it
  // would leave every badge stuck at its arrival count for a visitor who has just read the tab — a
  // dashboard arguing with the person using it, over a row describing nothing but their own
  // browsing.
  '/api/admin/tab-view',
]);

/** The refusal a viewer gets. JSON, because every caller here is a `fetch` from a dashboard. */
function refusal(): Response {
  return new Response(
    JSON.stringify({
      error: 'demo-read-only',
      // Read by the dashboards' own error handling, so a visitor sees a sentence rather than a
      // status code. It says what is true and does not apologise: nothing is broken.
      message: 'זו הדגמה — אפשר לראות הכול, אבל שינויים אינם נשמרים.',
    }),
    { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}

/**
 * Is this request carrying one of the two sessions the tour hands out?
 *
 * Asked of the SESSION, never of the path and never of "is demo mode on": a visitor who registered
 * has an account of their own and is an ordinary seller in it, and the application's own ownership
 * checks already keep them away from the showcase shops.
 */
async function isSharedDemoSession(context: APIContext): Promise<boolean> {
  const admin = adminRole(context.cookies);

  // The owner's password lifts the rule EVERYWHERE, including on a seller session for the showcase
  // account. Without this the rule refused him too — it recognises that account by its address, and
  // his browser is holding exactly that account when he edits the shops. Editing the showcase shops
  // through the dashboard is the reason the hourly rebuild was turned off and the reason this file
  // had to exist at all, so a rule that also locked HIM out would have removed the thing it exists
  // to protect. His route in: the password once at /admin/login, then the tour's seller door, then
  // edit normally.
  if (admin === 'owner') return false;

  // A viewer, not "no admin session": an unauthenticated request is the routes' own 401 to answer,
  // and turning it into a 403 here would tell a stranger that admin exists and is merely busy.
  if (admin === 'viewer') return true;

  const sellerId = getSellerSession(context.cookies);
  if (!sellerId) return false;
  const seller = await getSellerById(sellerId);
  return isSharedDemoAccount(seller?.email);
}

/**
 * `null` when the request may proceed, or the response to send instead.
 *
 * Deliberately cheap on the common path: outside demo mode, and on every GET, it returns before
 * touching a cookie. The allow-list is checked before the seller lookup, so a shopper's checkout
 * costs nothing either.
 */
export async function demoWriteRefusal(context: APIContext): Promise<Response | null> {
  if (!isDemoMode()) return null;
  if (!MUTATING.has(context.request.method)) return null;

  const pathname = new URL(context.request.url).pathname;
  if (DEMO_WRITE_ALLOWED.has(pathname)) return null;

  return (await isSharedDemoSession(context)) ? refusal() : null;
}
