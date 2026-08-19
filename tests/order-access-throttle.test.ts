import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isGuessedCredential } from '../src/lib/order-access.js';

/**
 * Every door into `resolveOrderAccess` that a stranger can knock on is metered.
 *
 * **The finding this pins (2026-08-19).** Three endpoints gated their rate limiter on
 * `!getSellerSession(cookies)` — "an anonymous request is a guess, a signed-in one is not". That is
 * true of the SESSION branch and false of the function as a whole: `resolveOrderAccess` also accepts
 * an order number plus the address it was placed with, and that door stays open to a signed-in
 * caller. Registration here is free and instant, so the limiter was removed for anyone who bothered
 * to make an account first. Two secrets at once is why it was a weakness rather than a break — and
 * the limiter exists so that nothing has to rest on that arithmetic staying true.
 *
 * A grep guard rather than three route tests, for the reason this repo keeps re-learning: the bug
 * was not in any one route, it was the same predicate written three times. The fourth copy was
 * being written when this was found.
 */

const API_DIR = join(process.cwd(), 'src', 'pages', 'api');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('the guessable order credential is throttled wherever it is accepted', () => {
  it('every caller of resolveOrderAccess runs isGuessedCredential', () => {
    const offenders = walk(API_DIR)
      .filter((file) => readFileSync(file, 'utf8').includes('resolveOrderAccess('))
      .filter((file) => !readFileSync(file, 'utf8').includes('isGuessedCredential('))
      .map((file) => file.replace(`${process.cwd()}/`, ''));

    expect(
      offenders,
      'This route resolves an order from a credential a stranger can GUESS (an 8-character\n'
      + 'reference plus the buying address). Gate the rate limiter on `isGuessedCredential(data)`,\n'
      + 'not on whether a session exists — order-access.ts says why that predicate was wrong.',
    ).toEqual([]);
  });

  it('no route still gates the order limiter on the mere absence of a session', () => {
    const offenders = walk(API_DIR)
      .filter((file) => {
        const src = readFileSync(file, 'utf8');
        if (!src.includes('resolveOrderAccess(')) return false;
        // The shape that was wrong: an `orderHelpRules` limiter reached only when nobody is signed
        // in. A route may still READ the session for other reasons — this looks for the two
        // together, which is the predicate itself.
        return /if\s*\(\s*!\s*getSellerSession\s*\(/.test(src) && src.includes('orderHelpRules(');
      })
      .map((file) => file.replace(`${process.cwd()}/`, ''));

    expect(offenders).toEqual([]);
  });
});

describe('what counts as a guess', () => {
  it('is the reference AND the address together, never one alone', () => {
    expect(isGuessedCredential({ orderRef: 'A1B2C3D4', email: 'a@b.test' })).toBe(true);
    // Half a guess resolves nothing, so counting it would spend a real buyer's allowance on a
    // request that could never have succeeded.
    expect(isGuessedCredential({ orderRef: 'A1B2C3D4' })).toBe(false);
    expect(isGuessedCredential({ email: 'a@b.test' })).toBe(false);
  });

  it('is not a signed link, and not a session acting on its own order', () => {
    // Both are strictly stronger than anything typed. Counting them would let a buyer with a real
    // mailed link be refused because strangers had been guessing from the same address all day.
    expect(isGuessedCredential({ orderId: 'x', token: 'sig' })).toBe(false);
    expect(isGuessedCredential({ orderId: 'x' })).toBe(false);
  });

  it('ignores whitespace, so a blank pair is not a guess', () => {
    expect(isGuessedCredential({ orderRef: '   ', email: '  ' })).toBe(false);
  });
});
