// Constant-time comparison for anything an attacker gets to guess repeatedly: a session
// signature, an admin password, a share token.
//
// `a === b` on strings stops at the first differing character, so how long the comparison took
// tells the guesser how much of their guess was right. That turns an infeasible search over the
// whole secret into a feasible one, character by character. The leak is small per request and
// network jitter hides most of it, but the caller is a login endpoint someone can hit in a loop,
// which is exactly the setting where averaging over many requests recovers the signal.

import crypto from 'node:crypto';

/**
 * True when both strings are identical, in time that does not depend on WHERE they differ.
 *
 * Compares SHA-256 digests rather than the raw bytes: `crypto.timingSafeEqual` throws on
 * length-mismatched inputs, and the throw itself would leak the secret's length. Digests are
 * always 32 bytes, so a length difference becomes an ordinary digest difference and every call
 * does the same amount of work.
 */
export function secretsEqual(a: string, b: string): boolean {
  const da = crypto.createHash('sha256').update(a, 'utf8').digest();
  const db = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}
