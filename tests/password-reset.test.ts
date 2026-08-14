import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '../src/lib/db.js';
import { store } from '../src/config/store.config.js';
import {
  issuePasswordResetToken,
  isPasswordResetTokenLive,
  redeemPasswordResetToken,
  purgeExpiredPasswordResetTokens,
  passwordResetUrl,
  RESET_TTL_MINUTES,
} from '../src/lib/password-reset.js';
import { loginSeller } from '../src/lib/seller-auth.js';

/**
 * The forgot-password flow, against a real Postgres.
 *
 * Every assertion here is about a way the flow can be WRONG rather than about it working, because
 * the working path is the one a person exercises by hand on the first day and the wrong ones are
 * the ones nobody meets until somebody is looking for them:
 *
 *   • a link that still works after it was used (replay),
 *   • a link that still works after it expired,
 *   • a link from one account setting the password of another (it cannot — the row carries the
 *     owner, and the caller never names one),
 *   • an unknown address answering differently from a known one (enumeration),
 *   • a rejected password burning the only link the person has.
 *
 * The token is checked to be absent from the table too. That is the property the whole storage
 * design exists for, and it is one careless `RETURNING` away from being untrue.
 */

const SELLER = '11111111-1111-4111-8111-000000000001';
const EMAIL = 'dana@example.test';
const OTHER = '11111111-1111-4111-8111-000000000002';

beforeEach(async () => {
  await query('DELETE FROM password_reset_tokens');
  // The fixture ships a placeholder hash; give this seller a real, known password so a successful
  // reset can be proved by SIGNING IN with the new one rather than by reading a column.
  await query(`UPDATE sellers SET password_hash = $2 WHERE id = $1`, [SELLER, 'scrypt:00:deadbeef']);
});

async function tokenRows(): Promise<{ token_hash: string; used_at: Date | null }[]> {
  const { rows } = await query<{ token_hash: string; used_at: Date | null }>(
    'SELECT token_hash, used_at FROM password_reset_tokens',
  );
  return rows;
}

describe('issuePasswordResetToken', () => {
  it('mints a token for a real address and stores only its hash', async () => {
    const issued = await issuePasswordResetToken(EMAIL);
    expect(issued).not.toBeNull();
    expect(issued!.seller.id).toBe(SELLER);
    expect(issued!.expiresInMinutes).toBe(RESET_TTL_MINUTES);
    // 32 bytes of hex — the entropy the SHA-256 storage decision rests on.
    expect(issued!.token).toMatch(/^[0-9a-f]{64}$/);

    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    // The clear token must exist NOWHERE in the table, under any column.
    expect(rows[0]!.token_hash).not.toBe(issued!.token);
    expect(rows[0]!.token_hash).toBe(crypto.createHash('sha256').update(issued!.token).digest('hex'));
    expect(rows[0]!.used_at).toBeNull();
  });

  it('returns null for an address nobody owns — and writes nothing', async () => {
    expect(await issuePasswordResetToken('nobody@example.test')).toBeNull();
    expect(await tokenRows()).toHaveLength(0);
  });

  it('is case-insensitive on the address, like signing in is', async () => {
    const issued = await issuePasswordResetToken('DANA@Example.test');
    expect(issued?.seller.id).toBe(SELLER);
  });

  it('invalidates the seller\'s earlier links — three clicks leave exactly one live', async () => {
    const first = await issuePasswordResetToken(EMAIL);
    const second = await issuePasswordResetToken(EMAIL);
    const third = await issuePasswordResetToken(EMAIL);

    expect(await tokenRows()).toHaveLength(1);
    expect(await isPasswordResetTokenLive(first!.token)).toBe(false);
    expect(await isPasswordResetTokenLive(second!.token)).toBe(false);
    expect(await isPasswordResetTokenLive(third!.token)).toBe(true);
  });

  it('does not touch another seller\'s links', async () => {
    await query(
      `INSERT INTO password_reset_tokens (seller_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour')`,
      [OTHER, crypto.createHash('sha256').update('other-token').digest('hex')],
    );
    await issuePasswordResetToken(EMAIL);
    expect(await isPasswordResetTokenLive('other-token')).toBe(true);
  });
});

describe('redeemPasswordResetToken', () => {
  it('sets the new password — and the seller can sign in with it', async () => {
    const issued = await issuePasswordResetToken(EMAIL);
    expect(await redeemPasswordResetToken(issued!.token, 'a-brand-new-one')).toBe('ok');

    const seller = await loginSeller(EMAIL, 'a-brand-new-one');
    expect(seller?.id).toBe(SELLER);
  });

  it('cannot be replayed — the second use of the same link fails', async () => {
    const issued = await issuePasswordResetToken(EMAIL);
    expect(await redeemPasswordResetToken(issued!.token, 'first-password')).toBe('ok');
    expect(await redeemPasswordResetToken(issued!.token, 'attacker-password')).toBe('invalid');

    // And the first password is still the live one — the replay changed nothing.
    expect(await loginSeller(EMAIL, 'first-password')).not.toBeNull();
    expect(await loginSeller(EMAIL, 'attacker-password')).toBeNull();
  });

  it('refuses an expired link, and says nothing different about it', async () => {
    const issued = await issuePasswordResetToken(EMAIL);
    await query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`);

    expect(await isPasswordResetTokenLive(issued!.token)).toBe(false);
    expect(await redeemPasswordResetToken(issued!.token, 'too-late-now')).toBe('invalid');
    expect(await loginSeller(EMAIL, 'too-late-now')).toBeNull();
  });

  it('refuses a token that was never issued', async () => {
    expect(await redeemPasswordResetToken('f'.repeat(64), 'some-password')).toBe('invalid');
    expect(await redeemPasswordResetToken('', 'some-password')).toBe('invalid');
  });

  it('rejects a short password WITHOUT spending the link', async () => {
    const issued = await issuePasswordResetToken(EMAIL);
    expect(await redeemPasswordResetToken(issued!.token, 'abc')).toBe('weak');
    // Still usable — a typo must not send the person back to their inbox for a new mail.
    expect(await isPasswordResetTokenLive(issued!.token)).toBe(true);
    expect(await redeemPasswordResetToken(issued!.token, 'long-enough')).toBe('ok');
  });

  it('changes only its OWN seller\'s password', async () => {
    await query(`UPDATE sellers SET password_hash = $2 WHERE id = $1`, [OTHER, 'scrypt:00:cafebabe']);
    const before = await query<{ password_hash: string }>(
      'SELECT password_hash FROM sellers WHERE id = $1', [OTHER],
    );

    const issued = await issuePasswordResetToken(EMAIL);
    await redeemPasswordResetToken(issued!.token, 'dana-only');

    const after = await query<{ password_hash: string }>(
      'SELECT password_hash FROM sellers WHERE id = $1', [OTHER],
    );
    expect(after.rows[0]!.password_hash).toBe(before.rows[0]!.password_hash);
  });
});

describe('the link that goes in the mail', () => {
  it('is built from the canonical origin', () => {
    const url = new URL(passwordResetUrl('abc123'));
    expect(url.origin).toBe(new URL(store.url).origin);
    expect(url.pathname).toBe('/seller/reset-password');
    expect(url.searchParams.get('token')).toBe('abc123');
  });

  /**
   * The tree scan, and the reason this file has one.
   *
   * A reset link built from `Astro.url` — whose host is the `Host` header the CALLER sent — mails a
   * real seller a real token pointing at whatever domain the attacker named. The mail is genuinely
   * from us and passes every check the seller could make. It is the single highest-value mistake
   * available in this flow, it is invisible in review because `new URL(path, Astro.url.origin)`
   * reads as ordinary, and it is exactly what the first version of this page did.
   *
   * So the rule is enforced by shape rather than by memory: nothing that BUILDS a mail may take its
   * origin from the request. The existing mails already obey it (`email/parts.ts#SITE`,
   * `critical-alert.ts` — both `store.url`); this stops the next one from not.
   */
  it('no email-sending code derives its origin from the request', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

    // Comments stripped first — the files that get this RIGHT are exactly the files that explain
    // the trap in prose, so a scan over raw source flags the fix as the bug.
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const offenders = walk('src')
      .filter((f) => /\.(ts|astro)$/.test(f))
      .filter((f) => {
        const src = code(readFileSync(f, 'utf8'));
        const sendsMail = /sendEmail\(|send[A-Za-z]*Email\(|passwordResetUrl\(/.test(src);
        const usesRequestOrigin = /(Astro\.url|request\.url|new URL\(request)/.test(src)
          && /\borigin\b/.test(src);
        return sendsMail && usesRequestOrigin;
      });
    expect(offenders).toEqual([]);
  });
});

describe('purgeExpiredPasswordResetTokens', () => {
  it('deletes what can no longer be used, and keeps what can', async () => {
    const live = await issuePasswordResetToken(EMAIL);
    await query(
      `INSERT INTO password_reset_tokens (seller_id, token_hash, expires_at)
       VALUES ($1, $2, now() - interval '2 hours')`,
      [OTHER, crypto.createHash('sha256').update('stale').digest('hex')],
    );

    expect(await purgeExpiredPasswordResetTokens()).toBe(1);
    expect(await isPasswordResetTokenLive(live!.token)).toBe(true);
  });
});
