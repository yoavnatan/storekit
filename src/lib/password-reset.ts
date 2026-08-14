/**
 * Forgot-password: issuing a one-time link, and spending it.
 *
 * The table's own header (`migrations/0026_password_reset_tokens.sql`) carries the storage
 * reasoning — why the token is hashed, why SHA-256 rather than scrypt, and the one thing a reset
 * deliberately does not do (end sessions already open). What this file owns is the PROTOCOL.
 *
 * ── The rule that shapes every signature here ────────────────────────────────
 *
 * **The caller must not be able to tell a registered address from an unregistered one.** A
 * forgot-password form is the most convenient account-enumeration oracle a site can offer: it takes
 * an address, needs no credential, and its honest answer is "yes, that person is a seller here".
 * Learning that is the first step of every credential-stuffing and phishing run, and for this
 * platform it also leaks who sells here under which private address.
 *
 * So `issuePasswordResetToken` returns `null` for an unknown address and the route says exactly the
 * same sentence either way — and the timing has to match too, which is why the caller must not skip
 * work in the null branch (see the note on the return type).
 *
 * ── Consuming is one statement ───────────────────────────────────────────────
 *
 * Expiry and single-use are both tested inside the same UPDATE that marks the row spent, so two
 * clicks landing together cannot both succeed: the first matches the row, the second matches
 * nothing. Reading the row, deciding, then writing would let both through.
 */

import crypto from 'node:crypto';
import { store } from '../config/store.config.js';
import { stripTrailingSlashes } from './url-base.js';
import { query, firstRow, isUuid } from './db.js';
import { getSellerByEmail, setSellerPassword, MIN_PASSWORD_LENGTH, type Seller } from './seller-auth.js';

/** How long a link lives. Long enough to survive a mail queue and a person finishing what they were
 *  doing; short enough that a link left in an inbox is not a standing key to the account. */
export const RESET_TTL_MINUTES = 60;

/** 32 bytes = 256 bits. There is nothing to guess here, which is the whole reason the stored form
 *  can be a plain SHA-256 (migration header). Hex rather than base64url so the value survives being
 *  pasted, quoted and re-encoded on its way through a mail client without changing. */
const TOKEN_BYTES = 32;

/** A real token is 64 hex characters. Anything longer is not a near-miss, so it is cut before it is
 *  hashed rather than after — the same reason `rate-limit.ts` caps the address it buckets on and
 *  `client-ip.ts` caps the address it stores: an unauthenticated POST decides this string's length,
 *  and no work should be proportional to a number the caller picked. */
const MAX_TOKEN_CHARS = 128;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token.slice(0, MAX_TOKEN_CHARS)).digest('hex');
}

/**
 * The absolute link that goes in the mail.
 *
 * **Built from `store.url`, never from the request's own origin** — and this is the one place in
 * the flow where getting it wrong is an account takeover rather than a broken page. `Astro.url`
 * derives its host from the `Host` header, which the caller sends: a POST to the forgot-password
 * form carrying `Host: attacker.example` would mint a real, valid token for a real seller and mail
 * that seller a link pointing at the attacker's server. The seller clicks a message that genuinely
 * came from us, and hands over the token.
 *
 * Every other absolute URL the platform mails is already built this way (`email/parts.ts#SITE`,
 * `critical-alert.ts`); this one is the reason the rule matters. The cost is that a link clicked
 * from a locally-triggered mail points at production — which is what `npm run email:preview` is
 * for, and is not a reason to trust a header.
 */
export function passwordResetUrl(token: string): string {
  return `${stripTrailingSlashes(store.url)}/seller/reset-password?token=${encodeURIComponent(token)}`;
}

export interface IssuedReset {
  seller: Seller;
  /** The clear token — it exists here and in the mail, and nowhere else, ever. */
  token: string;
  expiresInMinutes: number;
}

/**
 * Mint a link for whoever owns this address, or `null` if nobody does.
 *
 * **`null` is not an error and must not be reported as one.** The route's answer is identical
 * either way; see the file header. Callers should also avoid returning early on `null` in a way
 * that is visibly faster than the success path — the send is `void`ed and the response is the same
 * rendered page, which is what keeps the two indistinguishable in practice.
 *
 * Issuing invalidates the seller's earlier links. A person who presses the button three times
 * because nothing seemed to happen ends up with exactly one live link — the newest, the one they
 * are looking at — instead of three, and the two they are not looking at stop being usable at all.
 */
export async function issuePasswordResetToken(email: string): Promise<IssuedReset | null> {
  const seller = await getSellerByEmail(email);
  if (!seller) return null;

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');

  await query('DELETE FROM password_reset_tokens WHERE seller_id = $1', [seller.id]);
  await query(
    `INSERT INTO password_reset_tokens (seller_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [seller.id, hashToken(token), RESET_TTL_MINUTES],
  );

  return { seller, token, expiresInMinutes: RESET_TTL_MINUTES };
}

/**
 * Is this link still good? A READ — it does not spend the token.
 *
 * Used by the reset page's GET so a person who clicks a dead link is told immediately, instead of
 * choosing a new password, submitting it, and only then being told the link expired.
 */
export async function isPasswordResetTokenLive(token: string): Promise<boolean> {
  if (!token) return false;
  const row = await firstRow<{ id: string }>(
    `SELECT id FROM password_reset_tokens
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  return Boolean(row);
}

export type RedeemOutcome = 'ok' | 'invalid' | 'weak';

/**
 * Spend the link and set the new password.
 *
 * `invalid` covers unknown, expired and already-used, and does not distinguish them: all three mean
 * "ask for a new link", and telling a caller which one it was says whether a token ever existed.
 *
 * The password rule is checked BEFORE the token is spent — a too-short password is the user's own
 * form still being open, and burning their only link over it would send them back to the start for
 * a typo.
 */
export async function redeemPasswordResetToken(token: string, newPassword: string): Promise<RedeemOutcome> {
  if (!token) return 'invalid';
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) return 'weak';

  // Check, mark spent, and return the owner — one statement, so a second click matches nothing.
  const claimed = await firstRow<{ seller_id: string }>(
    `UPDATE password_reset_tokens
        SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING seller_id`,
    [hashToken(token)],
  );
  if (!claimed || !isUuid(claimed.seller_id)) return 'invalid';

  const ok = await setSellerPassword(claimed.seller_id, newPassword);
  // The row is already spent at this point and deliberately not restored. The only way here is a
  // seller deleted between the two statements, and ON DELETE CASCADE means the row is gone anyway.
  return ok ? 'ok' : 'invalid';
}

/**
 * Housekeeping, run by the scheduler (`jobs/registry.ts`). Size management only — an expired token
 * is already refused by the two statements above, which test the clock rather than the row's
 * existence. Idempotent: a second pass finds nothing.
 */
export async function purgeExpiredPasswordResetTokens(): Promise<number> {
  const { rowCount } = await query('DELETE FROM password_reset_tokens WHERE expires_at < now()');
  return rowCount;
}
