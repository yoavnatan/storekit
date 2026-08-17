import crypto from 'node:crypto';
import { requiredSecret } from './runtime-env.js';
import { secretsEqual } from './secret-compare.js';
import { machineUrl, stripTrailingSlashes } from './url-base.js';

/**
 * "The bearer holds this order" — the proof a GUEST carries instead of a session.
 *
 * Guest checkout is the default here (AI_INSTRUCTIONS → Checkout), so most buyers never have an
 * account and every screen that belongs to one order has to identify them some other way. This is
 * that way: an HMAC over the order id, mailed to the address the order was placed with.
 *
 * ── Two PURPOSES, two keys, on purpose ──
 * A link that invites someone to rate a product must not also be able to open a case that ends in
 * money moving. The purpose is folded into the signing key, so a `review` token simply does not
 * verify as a `help` one — there is no shared secret and no ordering trick that converts one into
 * the other. A page that has verified one and needs the other MINTS it (the review page does
 * exactly that for its "פנייה בנוגע להזמנה" link): it has already proved who the holder is, so
 * issuing the second is a statement about the same fact rather than an escalation.
 *
 * ── Stateless, and no expiry ──
 * Not a row in a table (`password_reset_tokens` is the other shape, and it is right for its job: a
 * reset must be single-use and burnable). This is not single-use — a buyer may come back a week
 * later — and what it authorises is bounded by the order, which is immutable. An invitation that
 * dies is a person who cannot reach us; rotating `AUTH_SECRET` invalidates every outstanding one
 * at once, which is the revocation this needs and the only one it needs.
 *
 * ── What it can and cannot do ──
 * It says "the bearer holds order X" and nothing else. Every rule still runs behind it: whether the
 * order may be reviewed, whether it may be cancelled or returned, which lines the regulations
 * allow, one review per purchase. A leaked link therefore lets a stranger do at most what the buyer
 * themselves could — the same exposure as a forwarded order-confirmation mail, and no more.
 */

export type OrderTokenPurpose = 'review' | 'help';

const SIG_LENGTH = 32;

function sign(orderId: string, purpose: OrderTokenPurpose): string {
  return crypto
    // Namespaced like every other signature in this codebase (`::csrf`, `::handoff`, `::admin`) and
    // then again by purpose, so neither a token from another module nor one from the other purpose
    // can be spent here.
    .createHmac('sha256', `${requiredSecret('AUTH_SECRET', 'dev-insecure-secret')}::order-${purpose}`)
    .update(orderId)
    .digest('base64url')
    .slice(0, SIG_LENGTH);
}

export function orderToken(orderId: string, purpose: OrderTokenPurpose): string {
  return sign(orderId, purpose);
}

/**
 * Does this token belong to this order, for this purpose?
 *
 * `secretsEqual`, never `===` — a signature comparison that returns early leaks its answer through
 * timing, and this project has one place that rule is written down and one function that obeys it
 * (AI_INSTRUCTIONS → Security review gate).
 */
export function verifyOrderToken(orderId: string, purpose: OrderTokenPurpose, token: unknown): boolean {
  if (typeof token !== 'string' || !token || !orderId) return false;
  return secretsEqual(token, sign(orderId, purpose));
}

/** The link in the review-invitation mail. */
export function reviewInviteUrl(baseUrl: string, orderId: string): string {
  return `${stripTrailingSlashes(baseUrl)}${machineUrl(`/review/${orderId}`)}?t=${orderToken(orderId, 'review')}`;
}

/**
 * "פנייה בנוגע להזמנה" — ONE label and ONE destination, wherever it appears: the order
 * confirmation, the status mails, the decision mail, the review page.
 *
 * The wording is deliberately neutral (owner, 2026-08-17). "לא מסכים?" puts the buyer opposite the
 * seller before they have said anything, and "יש בעיה?" invites everything including what this form
 * cannot act on. A buyer who meets the same four words in every mail learns there is ONE place for
 * anything to do with an order, which is worth more than any single sentence being warmer.
 *
 * The token rides along so the form arrives already knowing which order — a buyer who still has the
 * mail types nothing. One who deleted it can still reach the same form and give the order number
 * and their email instead (`order-access.ts`).
 */
export function orderHelpUrl(baseUrl: string, orderId: string): string {
  return `${stripTrailingSlashes(baseUrl)}/contact?order=${encodeURIComponent(orderId)}&t=${orderToken(orderId, 'help')}`;
}
