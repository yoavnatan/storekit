import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GUEST_SENDER_PREFIX, senderHasAccount } from '../src/lib/guest-sender.js';

/**
 * "This message was written by somebody with no account" is ONE predicate.
 *
 * Three places have to agree about it and they answer different questions with the same fact:
 * `/api/order-message` writes the value, `/api/messages` decides between an in-app notification and
 * a letter, and `seller-messages-query.ts` tells the seller which of those their reply will be.
 * Disagreement is silent in every direction — a notification written to a namespace no login can
 * open, or a seller told their answer travels by post when it does not.
 *
 * So the grep half of this file matters more than the unit half: the failure this repo keeps paying
 * for is not a wrong implementation, it is a SECOND one (`safe-redirect.test.ts` and
 * `email-address.test.ts` are the same shape). A hand-rolled `startsWith('order:')` would pass
 * every existing test on the day it was written and drift on some later one.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|astro)$/.test(full) ? [full] : [];
  });
}

describe('one definition of an account-less sender', () => {
  it('nobody hand-rolls the guest prefix', () => {
    const offenders = walk(SRC)
      .filter((file) => !file.endsWith(join('lib', 'guest-sender.ts')))
      .filter((file) => /['"`]order:['"`]|startsWith\(\s*['"`]order:/.test(readFileSync(file, 'utf8')))
      .map((file) => file.replace(`${process.cwd()}/`, ''));

    expect(
      offenders,
      'The `order:` prefix marks a sender with no account, and what depends on it is whether a\n'
      + 'reply becomes a notification or a letter. Import GUEST_SENDER_PREFIX / senderHasAccount\n'
      + 'from lib/guest-sender.ts instead of writing the string — a second copy drifts silently.',
    ).toEqual([]);
  });

  it('says a guest has no account, and an account id does', () => {
    expect(senderHasAccount(`${GUEST_SENDER_PREFIX}9f1c2d3e-0000-4000-8000-000000000001`)).toBe(false);
    expect(senderHasAccount('11111111-1111-4111-8111-000000000001')).toBe(true);
    // Pre-uuid ids from the JSON era are still accounts — `from_user_id` is text and has held
    // several shapes (messages.ts). Only the namespace means "no login".
    expect(senderHasAccount('u1')).toBe(true);
  });

  it('treats an empty sender as having no account', () => {
    // A row with no sender cannot be notified, and the caller must not try: `createNotification`
    // would write `user_id = ''`, a row nobody can ever read — which is the bug this predicate
    // exists to prevent, arriving through the other door.
    expect(senderHasAccount('')).toBe(false);
  });

  it('is not fooled by a prefix in the MIDDLE of an id', () => {
    // `startsWith`, not `includes`. An account id that happens to contain the word must not be
    // mistaken for a guest and silently cut off from its notifications.
    expect(senderHasAccount('acct-order:1')).toBe(true);
  });
});
