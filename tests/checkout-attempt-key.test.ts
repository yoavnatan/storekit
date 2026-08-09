import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkoutAttemptKey, clearCheckoutAttemptKey } from '../src/lib/checkout-attempt-key.js';
import { isValidIdempotencyKey } from '../src/lib/checkout-idempotency.js';

// The double-charge guard has two halves in two files, and this is the JOIN between them.
// `checkout-attempt-key.ts` mints the key in the browser; `isValidIdempotencyKey` in
// `checkout-idempotency.ts` decides on the server whether to accept it. Each half was correct and
// nothing checked that they agreed — the client file said so itself, in a comment: "Charset/length
// here must satisfy isValidIdempotencyKey() on the server". A comment is not a test, and tightening
// the server regex would have silently started rejecting every checkout.
//
// So this imports the REAL validator rather than restating its pattern. A second copy of the rule
// would pass while the actual join broke, which is the whole failure mode being closed here.
//
// It also pins the three mint paths separately, because they are not variations on one string —
// they are three different browsers, and only one of them runs in any given session.

type Cryptoish = { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array };

/** Minimal sessionStorage, so the persistence behaviour is exercised rather than stubbed away. */
function installStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
}

function withCrypto(c: Cryptoish | undefined): void {
  vi.stubGlobal('crypto', c);
}

// Distinct per call — a fixed stub would make two independently-minted keys equal and hide the one
// property the clear() test is asserting.
let mintCounter = 0;
const REAL_UUID = (): string => `123e4567-e89b-12d3-a456-42661417400${(mintCounter++) % 10}`;
const REAL_BYTES = (a: Uint8Array): Uint8Array => a.fill(mintCounter++ % 251);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the attempt key survives the retry it exists for', () => {
  it('returns the SAME key on a second call, so a resubmitted checkout is recognised as a replay', () => {
    installStorage();
    withCrypto({ randomUUID: REAL_UUID });

    // The dangerous case: the request succeeded, the response never arrived, the buyer presses again.
    const first = checkoutAttemptKey();
    const second = checkoutAttemptKey();

    expect(second).toBe(first);
  });

  it('mints a NEW key after a confirmed success, so the next purchase is not replayed as the last', () => {
    installStorage();
    withCrypto({ getRandomValues: REAL_BYTES });

    const first = checkoutAttemptKey();
    clearCheckoutAttemptKey();

    expect(checkoutAttemptKey()).not.toBe(first);
  });

  it('still returns a key when storage throws (private mode), rather than sending none', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('storage disabled'); },
      setItem: () => { throw new Error('storage disabled'); },
      removeItem: () => { throw new Error('storage disabled'); },
    });
    withCrypto(undefined);

    // A missing key is rejected outright by the server, so degrading to an unpersisted key is the
    // deliberate choice here — but it still has to be a key the server will take.
    expect(isValidIdempotencyKey(checkoutAttemptKey())).toBe(true);
    expect(() => clearCheckoutAttemptKey()).not.toThrow();
  });
});

describe('every mint path produces a key the SERVER accepts', () => {
  it('accepts the randomUUID path', () => {
    installStorage();
    withCrypto({ randomUUID: REAL_UUID });
    expect(isValidIdempotencyKey(checkoutAttemptKey())).toBe(true);
  });

  it('accepts the getRandomValues path', () => {
    installStorage();
    withCrypto({ getRandomValues: REAL_BYTES });
    expect(isValidIdempotencyKey(checkoutAttemptKey())).toBe(true);
  });

  it('accepts the last-resort path on a browser with no crypto at all', () => {
    installStorage();
    withCrypto(undefined);
    expect(isValidIdempotencyKey(checkoutAttemptKey())).toBe(true);
  });

  it('accepts the last-resort path even when Math.random degenerates', () => {
    // Found by reading the join rather than by a failure: `(0.5).toString(36)` is "0.i", so the
    // slice yields ONE character, and `(0).toString(36)` yields none. Two such draws in a row used
    // to put the key under the server's 16-char floor — a checkout rejected for its key rather than
    // for anything the buyer did. These are the exact values that produce the shortest output.
    for (const degenerate of [0, 0.5, 0.25, 0.75, 0.125]) {
      installStorage();
      withCrypto(undefined);
      vi.spyOn(Math, 'random').mockReturnValue(degenerate);

      const key = checkoutAttemptKey();
      expect(isValidIdempotencyKey(key), `Math.random() === ${degenerate} minted ${key}`).toBe(true);

      vi.restoreAllMocks();
    }
  });
});
