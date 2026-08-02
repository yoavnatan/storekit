/**
 * The seller account store, against a real Postgres — the first module moved off `data/*.json`
 * (DB_MIGRATION_PLAN.md §8 stage 2).
 *
 * **Why this file had to be written rather than inherited.** §9 leans on "the existing tests pass
 * unchanged" as the proof a module was replaced correctly. For sellers that proof was empty: the
 * suite had no behavioural coverage of this module at all — `seller-auth-password.test.ts` asserts
 * on the SOURCE TEXT (that scrypt is used, that the legacy branch exists), and the one other file
 * naming it replaces it with a stub. So the swap could have returned null for every account and the
 * suite would have stayed green. On the module that decides who is signed in, "the tests still
 * pass" has to mean something.
 *
 * What it therefore pins is the behaviour the file-backed version had, plus the two races the move
 * was supposed to close (§7.4) and the case-folding it was supposed to gain (§7.11).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import {
  createGoogleSeller,
  getAllSellers,
  getSellerByEmail,
  getSellerByGoogleId,
  getSellerById,
  linkGoogleAccount,
  loginSeller,
  registerSeller,
  updateSeller,
} from '../src/lib/seller-auth.js';

/** A fresh address per test — the fixture rows stay untouched so the ordering test can count on them. */
let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `new-${seq}@example.test`;
}

const FIXTURE_DANA = '11111111-1111-4111-8111-000000000001';

describe('reading an account', () => {
  it('returns the record behind an id, with the optional fields the app expects', async () => {
    const seller = await getSellerById(FIXTURE_DANA);
    expect(seller).toMatchObject({ id: FIXTURE_DANA, name: 'Dana', email: 'dana@example.test', tier: 'basic' });
    // Absent, not null: call sites write `seller.tier ?? DEFAULT`, which behaves differently on null.
    expect(await getSellerById('11111111-1111-4111-8111-000000000002')).not.toHaveProperty('tier');
    expect(await getSellerById('11111111-1111-4111-8111-000000000002')).not.toHaveProperty('googleId');
  });

  it('answers "no such seller" for an id that is not a uuid, instead of raising', async () => {
    // Postgres REJECTS a malformed uuid literal rather than not matching it, so without the shape
    // check this is a 500 on every page load carrying a stale cookie — not a signed-out visitor.
    await expect(getSellerById('seller-1')).resolves.toBeNull();
    await expect(getSellerById('')).resolves.toBeNull();
    await expect(getSellerById("' OR 1=1 --")).resolves.toBeNull();
  });

  it('finds an account by address regardless of case (§7.11)', async () => {
    expect((await getSellerByEmail('DANA@EXAMPLE.TEST'))?.id).toBe(FIXTURE_DANA);
  });

  it('returns a stable order, not the order the rows happen to sit in (§7.13)', async () => {
    const first = (await getAllSellers()).map((s) => s.id);
    // A table has no natural order; an UPDATE is exactly what reshuffles an unordered scan.
    await query(`UPDATE sellers SET name = name WHERE id = $1`, [first[0]]);
    expect((await getAllSellers()).map((s) => s.id)).toEqual(first);
    // And it really is every seller, not a page of them. Counted rather than hardcoded: the fixture
    // holds three sellers but two share an address bar their case, and the import drops the second
    // (§7.11) — a literal 3 here would read as a bug in this function instead of the fixture trap.
    const { rows } = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM sellers');
    expect(first.length).toBe(rows[0]!.n);
  });
});

describe('registration', () => {
  it('creates an account that can then be read back and signed into', async () => {
    const email = freshEmail();
    const seller = await registerSeller(email, 'hunter2', 'New Person');
    expect(seller).not.toBeNull();
    expect(await getSellerById(seller!.id)).toMatchObject({ email, name: 'New Person' });
    expect((await loginSeller(email, 'hunter2'))?.id).toBe(seller!.id);
    expect(await loginSeller(email, 'wrong')).toBeNull();
  });

  it('never stores the password itself', async () => {
    const email = freshEmail();
    const seller = await registerSeller(email, 'hunter2', 'X');
    expect(seller!.passwordHash).not.toContain('hunter2');
    expect(seller!.passwordHash.startsWith('scrypt:')).toBe(true);
  });

  it('refuses a taken address, including one that differs only in case (§7.11)', async () => {
    const email = freshEmail();
    expect(await registerSeller(email, 'a', 'First')).not.toBeNull();
    expect(await registerSeller(email, 'b', 'Second')).toBeNull();
    expect(await registerSeller(email.toUpperCase(), 'c', 'Third')).toBeNull();
  });

  it('lets only one of two simultaneous registrations win (§7.4)', async () => {
    // The old form read, looked for the address, then wrote — so two requests in the same moment
    // both found nothing and both got an account. This is the race that check-then-write cannot
    // close and a unique index closes for free.
    const email = freshEmail();
    const results = await Promise.all([
      registerSeller(email, 'a', 'One'),
      registerSeller(email, 'b', 'Two'),
      registerSeller(email, 'c', 'Three'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const { rowCount } = await query('SELECT id FROM sellers WHERE email = $1', [email]);
    expect(rowCount).toBe(1);
  });
});

describe('signing in', () => {
  it('accepts the address in any case', async () => {
    const email = freshEmail();
    await registerSeller(email, 'hunter2', 'X');
    expect(await loginSeller(email.toUpperCase(), 'hunter2')).not.toBeNull();
  });

  it('upgrades a pre-2026-07-29 fast-hash record on a successful sign-in, and persists it', async () => {
    // The one moment the plaintext password exists, so the only place the record CAN be rehashed
    // without forcing a reset. A version that upgraded in memory only would pass a weaker test.
    const email = freshEmail();
    const salt = crypto.randomBytes(16).toString('hex');
    const legacy = `${salt}:${crypto.createHmac('sha256', salt).update('hunter2').digest('hex')}`;
    await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'Legacy', $2, $3)`,
      [crypto.randomUUID(), email, legacy]);

    expect(await loginSeller(email, 'hunter2')).not.toBeNull();

    const { rows } = await query<{ password_hash: string }>(
      'SELECT password_hash FROM sellers WHERE email = $1', [email]);
    expect(rows[0]!.password_hash.startsWith('scrypt:')).toBe(true);
    expect(await loginSeller(email, 'hunter2')).not.toBeNull();   // and still signs in afterwards
    expect(await loginSeller(email, 'nope')).toBeNull();
  });

  it('rejects an account with no password rather than letting an empty one through', async () => {
    // OAuth-only accounts carry an empty hash. `verifyPassword('' , '')` must not be a match, or
    // every Google account is signable-into with a blank password.
    const seller = await createGoogleSeller(freshEmail(), 'G', `g-${seq}`);
    expect(await loginSeller(seller.email, '')).toBeNull();
  });
});

describe('editing an account', () => {
  let id: string;
  let email: string;

  beforeEach(async () => {
    email = freshEmail();
    id = (await registerSeller(email, 'hunter2', 'Before'))!.id;
  });

  it('renames without disturbing anything else', async () => {
    const result = await updateSeller(id, { name: 'After' });
    expect(result).toMatchObject({ ok: true });
    expect(await getSellerById(id)).toMatchObject({ name: 'After', email });
    expect(await loginSeller(email, 'hunter2')).not.toBeNull();
  });

  it('changes the password only against the current one', async () => {
    expect(await updateSeller(id, { newPassword: 'x' })).toMatchObject({ ok: false, error: 'נדרשת סיסמה נוכחית' });
    expect(await updateSeller(id, { currentPassword: 'wrong', newPassword: 'x' }))
      .toMatchObject({ ok: false, error: 'הסיסמה הנוכחית שגויה' });
    // …and neither failed attempt may have changed it.
    expect(await loginSeller(email, 'hunter2')).not.toBeNull();

    expect(await updateSeller(id, { currentPassword: 'hunter2', newPassword: 'newpass' })).toMatchObject({ ok: true });
    expect(await loginSeller(email, 'newpass')).not.toBeNull();
    expect(await loginSeller(email, 'hunter2')).toBeNull();
  });

  it('leaves a field this request did not carry exactly as it was', async () => {
    // The repo's standing save rule (lib/record-rev.ts): a save must never revert a field the
    // seller did not touch. A read-modify-write here means a profile save carrying only an address,
    // racing a rename from another tab, silently puts the old name back.
    await query('UPDATE sellers SET name = $2 WHERE id = $1', [id, 'Renamed Elsewhere']);
    const newEmail = freshEmail();
    expect(await updateSeller(id, { email: newEmail })).toMatchObject({ ok: true });
    expect(await getSellerById(id)).toMatchObject({ name: 'Renamed Elsewhere', email: newEmail });
  });

  it('refuses to move onto an address another account holds', async () => {
    expect(await updateSeller(id, { email: 'dana@example.test' }))
      .toMatchObject({ ok: false, error: 'כתובת המייל כבר בשימוש' });
    // The rejection must leave the record exactly as it was — not half-applied.
    expect(await getSellerById(id)).toMatchObject({ name: 'Before', email });
  });

  it('reports a missing account instead of silently succeeding', async () => {
    expect(await updateSeller(crypto.randomUUID(), { name: 'X' })).toMatchObject({ ok: false, error: 'משתמש לא נמצא' });
    expect(await updateSeller('not-a-uuid', { name: 'X' })).toMatchObject({ ok: false });
  });
});

describe('google accounts', () => {
  it('creates one with no password and finds it again by google id', async () => {
    const email = freshEmail();
    const googleId = `google-${seq}`;
    const seller = await createGoogleSeller(email, 'Gina', googleId);
    expect(seller.passwordHash).toBe('');
    expect(seller.googleId).toBe(googleId);
    expect((await getSellerByGoogleId(googleId))?.id).toBe(seller.id);
  });

  it('links a google id onto an existing password account', async () => {
    const email = freshEmail();
    const seller = (await registerSeller(email, 'hunter2', 'Linkable'))!;
    const googleId = `google-link-${seq}`;
    await linkGoogleAccount(seller.id, googleId);
    expect((await getSellerByGoogleId(googleId))?.id).toBe(seller.id);
    // Linking must not cost the password sign-in.
    expect(await loginSeller(email, 'hunter2')).not.toBeNull();
  });

  it('signs the loser of a simultaneous first sign-in into the same account', async () => {
    // The caller only reaches createGoogleSeller after finding no account — which stops being true
    // the moment two callbacks for one new address arrive together, and that happens (a double
    // click, a retried redirect). One person must end up with one account, and the second request
    // must be signed in rather than shown an error.
    const email = freshEmail();
    const googleId = `google-race-${seq}`;
    const both = await Promise.all([
      createGoogleSeller(email, 'Gina', googleId),
      createGoogleSeller(email, 'Gina', googleId),
    ]);
    expect(both[0].id).toBe(both[1].id);
    const { rowCount } = await query('SELECT id FROM sellers WHERE email = $1', [email]);
    expect(rowCount).toBe(1);
  });

  it('ignores a link for an id that is not a uuid', async () => {
    await expect(linkGoogleAccount('seller-1', 'google-x')).resolves.toBeUndefined();
    expect(await getSellerByGoogleId('google-x')).toBeNull();
  });
});
