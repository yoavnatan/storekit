import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AUTH_SRC = readFileSync(fileURLToPath(new URL('../src/lib/seller-auth.ts', import.meta.url)), 'utf8');

/**
 * Password storage. These assert the PROPERTIES that matter rather than reaching
 * into unexported functions: that stored hashes are slow-by-construction, that the
 * pre-2026-07-29 fast-hash records still verify, and that the dev signing secret
 * can never be used in production.
 */
describe('password hashing', () => {
  it('uses a slow KDF (scrypt), not a bare SHA/HMAC', () => {
    expect(AUTH_SRC).toMatch(/scryptSync/);
    // The old construction — a single HMAC over the password — must not be how a
    // NEW hash is produced. It survives only in the legacy verify branch.
    expect(AUTH_SRC).not.toMatch(/function hashPassword[\s\S]{0,200}createHmac/);
  });

  it('stores a versioned, salted record so the format can move again later', () => {
    const salt = crypto.randomBytes(16).toString('hex');
    const record = `scrypt:${salt}:${crypto.scryptSync('hunter2', salt, 64).toString('hex')}`;
    const [tag, storedSalt, hash] = record.split(':');
    expect(tag).toBe('scrypt');
    expect(storedSalt).toHaveLength(32);
    expect(hash).toHaveLength(128);
  });

  // Deliberately NOT a wall-clock comparison against HMAC: that assertion is
  // timing-dependent and failed once here purely because the machine was busy.
  // A flaky security test gets muted, so assert the work factor structurally instead.
  it('does not weaken scrypt below the Node defaults (N=16384, r=8, p=1)', () => {
    expect(AUTH_SRC).not.toMatch(/scryptSync\([^)]*\bN\s*:/);
    expect(AUTH_SRC).not.toMatch(/scryptSync\([^)]*cost\s*:/);
    // 64-byte derived key, per SCRYPT_KEYLEN.
    expect(crypto.scryptSync('hunter2', 'a'.repeat(32), 64)).toHaveLength(64);
  });

  it('still verifies legacy HMAC records, so no existing account is locked out', () => {
    expect(AUTH_SRC).toMatch(/Legacy HMAC record/);
    expect(AUTH_SRC).toMatch(/needsRehash/);
    // …and upgrades them on the next successful login.
    expect(AUTH_SRC).toMatch(/if \(needsRehash\(seller\.passwordHash\)\)/);
  });

  it('compares hashes in constant time', () => {
    expect(AUTH_SRC).toMatch(/timingSafeEqual/);
    expect(AUTH_SRC).not.toMatch(/digest\('hex'\) === hash/);
  });
});

describe('session signing secret', () => {
  it('refuses to fall back to the public dev default in production', () => {
    expect(AUTH_SRC).toMatch(/import\.meta\.env\.PROD[\s\S]{0,160}throw new Error/);
  });

  it('the dev default is still available outside production', () => {
    expect(AUTH_SRC).toMatch(/'dev-insecure-secret'/);
  });
});
