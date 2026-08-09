/**
 * The buyer's side of the double-charge guard (server side: checkout-idempotency.ts).
 *
 * One key per checkout ATTEMPT, held in sessionStorage. The important property is
 * that it SURVIVES a failed submit: the case most likely to charge twice is the one
 * where the request actually succeeded but the response never arrived, and the buyer
 * presses the button again. Only a key that is reused on that second press lets the
 * server recognise the retry. A key minted fresh per click would look like a brand
 * new purchase and buy no protection at all.
 *
 * It is cleared only on a CONFIRMED success, so the buyer's next purchase is treated
 * as new rather than replayed as the previous one.
 *
 * sessionStorage rather than a module variable: a refresh mid-checkout (or a
 * back-navigation onto a re-executed page) drops module state but is exactly the
 * moment the key still needs to be the same one.
 */

const STORAGE_KEY = 'sn_checkout_attempt';

/** Charset/length here must satisfy isValidIdempotencyKey() on the server. */
function mintKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `co-${c.randomUUID()}`;
  // Older browsers: getRandomValues is far more widely supported than randomUUID.
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return `co-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  // Last resort. Weaker, but the key only needs to be unique per buyer session —
  // it is a de-duplication token, never a secret or an authorisation.
  //
  // `padEnd` is not cosmetic: `Math.random().toString(36)` is only ~12 chars for a TYPICAL value.
  // A degenerate one is far shorter — 0.5 renders as "0.i", leaving one character after the slice,
  // and 0 leaves none — which used to be able to mint a key under the server's 16-char floor, i.e.
  // a checkout the server rejects outright. Padding makes the length structural rather than
  // probabilistic. Pinned by tests/checkout-attempt-key.test.ts against the real validator.
  // eslint-disable-next-line sonarjs/pseudo-random -- reviewed: a de-duplication token, not a
  // secret. crypto is used whenever it exists; this path is for browsers that have neither
  // randomUUID nor getRandomValues. Guessing another buyer's key grants nothing, because the
  // server binds a completed record to its owner (sha256 of the email) and replays only to them.
  const chunk = (): string => Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `co-${Date.now().toString(36).padEnd(8, '0')}-${chunk()}-${chunk()}`;
}

/** The current attempt's key, minting and persisting one on first use. */
export function checkoutAttemptKey(): string {
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const key = mintKey();
    sessionStorage.setItem(STORAGE_KEY, key);
    return key;
  } catch {
    // Private mode / storage disabled. A fresh key each time is strictly worse than
    // a persisted one, but it is still better than sending none: the server rejects
    // a missing key outright, and concurrent duplicate submits are caught by the
    // button's disabled state plus the server's in-progress claim.
    return mintKey();
  }
}

/** Call ONLY after a confirmed successful checkout. */
export function clearCheckoutAttemptKey(): void {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
}
