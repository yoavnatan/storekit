import crypto from 'node:crypto';
import { requiredSecret } from './runtime-env.js';
import { secretsEqual } from './secret-compare.js';
import { machineUrl, stripTrailingSlashes } from './url-base.js';

/**
 * The guest's proof of purchase: a signed link to review one order, with no account behind it.
 *
 * Why this exists at all is argued in `review-eligibility.ts` — guest checkout is the default here,
 * so a review system reachable only by signed-in buyers would be a review system with almost
 * nothing in it. The reviewer still has to have BOUGHT the thing; this is just the way that fact
 * travels to someone who never set a password.
 *
 * ── Stateless on purpose ──
 * An HMAC over the order id, not a row in a tokens table (`password_reset_tokens` is the other
 * shape, and it is right for its job: a reset token must be single-use and burnable). This one is
 * not single-use — a buyer may come back and review a second item from the same order a week
 * later — and what it authorises is bounded by the order itself, which is already immutable. A
 * table would buy an expiry nobody wants and a delete nobody would call.
 *
 * ── What it can and cannot do ──
 * It says "the bearer bought order X" and nothing else. Every real check still runs behind it:
 * the order must be in a reviewable state (`review-eligibility.ts`), the product must be a line IN
 * that order, and one purchase still earns one review (the DB constraint). A leaked link therefore
 * lets a stranger write at most the reviews the buyer themselves could have written — the same
 * exposure as a forwarded order-confirmation email, and no more.
 *
 * ── No expiry, deliberately ──
 * A review invitation that dies is a review that never gets written, and the link grants nothing
 * time-sensitive. Rotating `AUTH_SECRET` invalidates every outstanding one at once, which is the
 * revocation this needs and the only one it needs.
 */

const SIG_LENGTH = 32;

function sign(orderId: string): string {
  return crypto
    // Namespaced like every other signature in this codebase (`::csrf`, `::handoff`, `::admin`), so
    // a token minted here can never be replayed as one of those and vice versa.
    .createHmac('sha256', `${requiredSecret('AUTH_SECRET', 'dev-insecure-secret')}::review`)
    .update(orderId)
    .digest('base64url')
    .slice(0, SIG_LENGTH);
}

/** The `t=` value for one order. */
export function reviewToken(orderId: string): string {
  return sign(orderId);
}

/**
 * Does this token belong to this order?
 *
 * `secretsEqual`, never `===` — a signature comparison that returns early leaks its answer through
 * timing, and this project has one place that rule is written down and one function that obeys it
 * (AI_INSTRUCTIONS → Security review gate).
 */
export function verifyReviewToken(orderId: string, token: unknown): boolean {
  if (typeof token !== 'string' || !token || !orderId) return false;
  return secretsEqual(token, sign(orderId));
}

/**
 * The link that goes in the invitation email.
 *
 * `machineUrl`, because the path carries an order id and the base may be a Hebrew-slugged origin —
 * every URL this project hands to a machine goes through it (AI_INSTRUCTIONS → SEO).
 */
export function reviewInviteUrl(baseUrl: string, orderId: string): string {
  return `${stripTrailingSlashes(baseUrl)}${machineUrl(`/review/${orderId}`)}?t=${reviewToken(orderId)}`;
}
