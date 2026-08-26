import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/db.js';
import { DEMO_BUYER_EMAIL, DEMO_SELLER_EMAIL } from '../src/lib/demo-mode.js';
import { updateSeller } from '../src/lib/seller-auth.js';

/**
 * The one door demo mode locks, and the three it must not.
 *
 * `/demo` signs every visitor into the SAME seller and buyer account. So one visitor changing that
 * account's email or password locks out everybody who follows — including whoever the owner sent
 * the link to — and the hourly reset is an hour too slow to be the answer.
 *
 * The interesting assertions here are the negative ones. A lock that is slightly too wide is the
 * more likely mistake and the more damaging one: it would stop a visitor who registered his own
 * shop from managing his own login, and that flow is a large part of what the demonstration is FOR.
 */

const SHARED = '99999999-9999-4999-8999-000000000001';
const OWN = '99999999-9999-4999-8999-000000000002';
const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;

beforeEach(async () => {
  // Stores first: `stores.seller_id` is ON DELETE RESTRICT, so an account with a shop cannot go.
  await query('DELETE FROM stores');
  await query('DELETE FROM sellers');
  await query('INSERT INTO sellers (id, name, email) VALUES ($1, $2, $3)', [SHARED, 'Showcase', DEMO_SELLER_EMAIL]);
  await query('INSERT INTO sellers (id, name, email) VALUES ($1, $2, $3)', [OWN, 'Visitor', 'visitor@example.com']);
  process.env.DEMO_MODE = '1';
});

afterEach(() => {
  if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
});

describe('the shared demo accounts', () => {
  it('refuse an email change', async () => {
    const res = await updateSeller(SHARED, { email: 'taken@example.com' });
    expect(res.ok).toBe(false);
    const { rows } = await query<{ email: string }>('SELECT email FROM sellers WHERE id = $1', [SHARED]);
    expect(rows[0]!.email).toBe(DEMO_SELLER_EMAIL);
  });

  it('refuse a password change', async () => {
    const res = await updateSeller(SHARED, { currentPassword: 'x', newPassword: 'newpassword' });
    expect(res.ok).toBe(false);
  });

  it('still accept a NAME change — the demonstration is meant to be used', async () => {
    // The lock is about locking people out, not about freezing the exhibit. A visitor renaming the
    // business is a change the reset will undo within the hour and nobody is shut out by.
    const res = await updateSeller(SHARED, { name: 'שם חדש' });
    expect(res.ok).toBe(true);
  });

  it('cover the buyer account too', async () => {
    await query('UPDATE sellers SET email = $2 WHERE id = $1', [OWN, DEMO_BUYER_EMAIL]);
    const res = await updateSeller(OWN, { email: 'somethingelse@example.com' });
    expect(res.ok).toBe(false);
  });
});

describe('an account a visitor made for himself', () => {
  it('may change its own email and password like any seller', async () => {
    // The failure mode that matters more than the lock: a visitor who registers a shop and cannot
    // manage his own login has been shown a broken application, not a demonstration.
    expect((await updateSeller(OWN, { email: 'mine@example.com' })).ok).toBe(true);
  });
});

describe('outside demo mode', () => {
  it('locks nothing, even on an account with those exact addresses', async () => {
    // The flag is what turns this on. A production deployment that happened to hold an account at
    // one of these addresses must behave exactly as it always has.
    delete process.env.DEMO_MODE;
    expect((await updateSeller(SHARED, { email: 'renamed@example.com' })).ok).toBe(true);
  });
});
