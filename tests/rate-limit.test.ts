import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/db.js';
import {
  adminLoginRules,
  checkAuthRate,
  clearAuthRate,
  countAuthAttempt,
  purgeExpiredAuthAttempts,
  registerRules,
  retryAfterMinutes,
  sellerLoginRules,
} from '../src/lib/rate-limit.js';
import { clientIp } from '../src/lib/client-ip.js';
import { cleanGitEnv } from './helpers/git-env.js';

/**
 * Brute-force throttling on the three credential surfaces (GO_LIVE §7).
 *
 * Written against a real Postgres rather than a fake store on purpose: the property that matters is
 * that the counter is SHARED and the increment is ATOMIC, and neither can be asserted against an
 * in-process Map — which is exactly the implementation this replaces the need for. The concurrency
 * case below is the one that decides it.
 */

const IP = '203.0.113.9';

beforeEach(async () => {
  await query('DELETE FROM auth_attempts');
});

async function failLogin(email: string, ip: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await countAuthAttempt(sellerLoginRules(email, ip));
}

describe('seller login', () => {
  it('allows the attempt while under the limit', async () => {
    await failLogin('seller@example.com', IP, 7);
    expect((await checkAuthRate(sellerLoginRules('seller@example.com', IP))).allowed).toBe(true);
  });

  it('blocks the account once the identity limit is reached', async () => {
    await failLogin('seller@example.com', IP, 8);
    const verdict = await checkAuthRate(sellerLoginRules('seller@example.com', IP));
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSec).toBeGreaterThan(0);
  });

  it('is not bypassed by changing the case or padding of the address', async () => {
    await failLogin('seller@example.com', IP, 8);
    // Same account, typed differently — must land in the SAME bucket, or the limit is decorative.
    expect((await checkAuthRate(sellerLoginRules('  SELLER@Example.com ', IP))).allowed).toBe(false);
  });

  it('blocks only the targeted account, not every seller on that address', async () => {
    await failLogin('victim@example.com', IP, 8);
    // A different account from the same office/NAT is still under the (looser) origin limit.
    expect((await checkAuthRate(sellerLoginRules('colleague@example.com', IP))).allowed).toBe(true);
  });

  it('blocks one source spraying many accounts, which the identity bucket cannot see', async () => {
    // 30 addresses, ONE failure each: every identity bucket sits at 1, so only the origin bucket
    // can catch this. This is the case a per-account limiter alone misses entirely.
    for (let i = 0; i < 30; i++) await failLogin(`target${i}@example.com`, IP, 1);
    expect((await checkAuthRate(sellerLoginRules('target99@example.com', IP))).allowed).toBe(false);
    // A different source is unaffected — the block is on the sprayer, not on the platform.
    expect((await checkAuthRate(sellerLoginRules('target99@example.com', '198.51.100.4'))).allowed).toBe(true);
  });

  it('a correct password wipes the slate, so old typos never accumulate into a lockout', async () => {
    await failLogin('seller@example.com', IP, 7);
    await clearAuthRate(sellerLoginRules('seller@example.com', IP));
    await failLogin('seller@example.com', IP, 7);
    expect((await checkAuthRate(sellerLoginRules('seller@example.com', IP))).allowed).toBe(true);
  });

  it('counts concurrent failures exactly once each — the limit is not doubled by racing', async () => {
    // The reason the counter is a single INSERT … ON CONFLICT and not read-then-write: eight
    // parallel guesses must leave the bucket at 8, not at 2. A read-modify-write here would let
    // them all read the same value and write the same increment, which is precisely the traffic
    // pattern an attacker produces.
    const rules = sellerLoginRules('seller@example.com', IP);
    await Promise.all(Array.from({ length: 8 }, () => countAuthAttempt(rules)));
    expect((await checkAuthRate(rules)).allowed).toBe(false);
  });

  it('forgets an expired window instead of locking the account out forever', async () => {
    await failLogin('seller@example.com', IP, 8);
    // Age the row past the 15-minute window without waiting for it.
    await query("UPDATE auth_attempts SET window_start = now() - interval '16 minutes'");
    expect((await checkAuthRate(sellerLoginRules('seller@example.com', IP))).allowed).toBe(true);
  });

  it('the next failure after an expired window starts a fresh count, not a resumed one', async () => {
    await failLogin('seller@example.com', IP, 8);
    await query("UPDATE auth_attempts SET window_start = now() - interval '16 minutes'");
    await failLogin('seller@example.com', IP, 1);
    // If the increment resumed from 8 the account would be blocked again by that single attempt.
    expect((await checkAuthRate(sellerLoginRules('seller@example.com', IP))).allowed).toBe(true);
  });
});

describe('a hostile address does not take the sign-in page down', () => {
  it('caps the bucket, because an oversized key breaks the primary key index', async () => {
    // Measured against the real database: `bucket` is the primary key and a btree entry may not
    // exceed 2704 bytes, so a ~5000-character `email` in the POST failed the INSERT with
    // `index row size 5024 exceeds btree version 4 maximum` — a 500 on the login page from one
    // unauthenticated request. Random, not repeated characters: `'a'.repeat(5000)` compresses away
    // and does NOT reproduce it, which is how this hides from a casual test.
    const huge = `${Array.from({ length: 5000 }, (_, i) => String.fromCharCode(97 + (i * 7) % 26)).join('')}@x.com`;
    await expect(countAuthAttempt(sellerLoginRules(huge, IP))).resolves.toBeUndefined();
    await expect(checkAuthRate(sellerLoginRules(huge, IP))).resolves.toBeDefined();
  });

  it('does not let one absurd address collide with a real account', async () => {
    // The cap truncates; it must not truncate two different accounts into one bucket in any case
    // reachable by a real address (254 = the RFC 5321 maximum).
    const real = 'seller@example.com';
    await failLogin(real, IP, 8);
    expect((await checkAuthRate(sellerLoginRules(`${'x'.repeat(400)}@x.com`, IP))).allowed).toBe(true);
  });
});

describe('admin login', () => {
  it('gets the tightest limit — one shared secret, no second factor', async () => {
    for (let i = 0; i < 5; i++) await countAuthAttempt(adminLoginRules(IP));
    expect((await checkAuthRate(adminLoginRules(IP))).allowed).toBe(false);
    // Four would still be allowed: the limit is 5, and it must be lower than the seller's 8.
    await query('DELETE FROM auth_attempts');
    for (let i = 0; i < 4; i++) await countAuthAttempt(adminLoginRules(IP));
    expect((await checkAuthRate(adminLoginRules(IP))).allowed).toBe(true);
  });

  it('does not share a bucket with a seller login from the same address', async () => {
    for (let i = 0; i < 5; i++) await countAuthAttempt(adminLoginRules(IP));
    expect((await checkAuthRate(sellerLoginRules('seller@example.com', IP))).allowed).toBe(true);
  });
});

describe('registration', () => {
  it('is limited per source, and counts successes too — mass signup is the behaviour limited', async () => {
    for (let i = 0; i < 30; i++) await countAuthAttempt(registerRules(IP));
    expect((await checkAuthRate(registerRules(IP))).allowed).toBe(false);
  });

  it('cannot be used to lock a specific address out of ever registering', async () => {
    // Keying registration on the submitted address would make this possible: burn a competitor's
    // address, and they can never sign up. The bucket is the source, so a different source is free.
    for (let i = 0; i < 30; i++) await countAuthAttempt(registerRules(IP));
    expect((await checkAuthRate(registerRules('198.51.100.4'))).allowed).toBe(true);
  });
});

// The cut-off is MAX_RATE_WINDOW_SEC — the LONGEST window any surface uses — and not this file's
// own 15-minute auth window. It was the auth window until 2026-08-10, which was correct only while
// this file was the only caller: lib/message-flood.ts buckets over an hour, and a 15-minute purge
// would have deleted its rows at minute 16, silently switching the message limiter off. Hence
// '2 hours' below rather than '16 minutes'. tests/message-flood.test.ts holds the other half — that
// a still-live hour-long bucket survives a purge.
describe('purge job', () => {
  it('drops lapsed rows and leaves live ones', async () => {
    await failLogin('old@example.com', IP, 3);
    await query("UPDATE auth_attempts SET window_start = now() - interval '2 hours'");
    await failLogin('fresh@example.com', '198.51.100.7', 3);

    expect(await purgeExpiredAuthAttempts()).toBeGreaterThan(0);
    const { rows } = await query<{ bucket: string }>('SELECT bucket FROM auth_attempts');
    expect(rows.every((r) => !r.bucket.includes('old@example.com'))).toBe(true);
    expect(rows.some((r) => r.bucket.includes('fresh@example.com'))).toBe(true);
  });

  it('is idempotent — a second pass finds nothing left', async () => {
    await failLogin('old@example.com', IP, 3);
    await query("UPDATE auth_attempts SET window_start = now() - interval '2 hours'");
    await purgeExpiredAuthAttempts();
    expect(await purgeExpiredAuthAttempts()).toBe(0);
  });
});

describe('client address', () => {
  const withHeaders = (headers: Record<string, string>): Request =>
    new Request('https://dezabin.co.il/seller/login', { headers });

  it('ignores a forwarded-for header by default — it is a claim, not a fact', async () => {
    // Without TRUST_PROXY_IP the origin is reachable directly, so anyone could mint a fresh
    // rate-limit bucket per request by sending this header.
    expect(clientIp(withHeaders({ 'x-forwarded-for': '1.2.3.4' }), '203.0.113.9')).toBe('203.0.113.9');
    expect(clientIp(withHeaders({ 'cf-connecting-ip': '1.2.3.4' }), '203.0.113.9')).toBe('203.0.113.9');
  });

  it('treats an IPv6-mapped IPv4 address as the same caller', () => {
    expect(clientIp(withHeaders({}), '::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('never returns an empty identifier', () => {
    expect(clientIp(withHeaders({}), undefined)).toBe('unknown');
  });
});

describe('every credential surface is actually gated', () => {
  // The pattern from tests/safe-redirect.test.ts and tests/email-address.test.ts: the rule is not
  // "remember to call the limiter", it is a grep that fails when someone doesn't. A second sign-in
  // surface added later — a password reset, a second admin entry point — is exactly the case where
  // the throttling would be forgotten, and the forgetting is silent.
  const VERIFIERS = ['loginSeller', 'checkAdminPassword', 'registerSeller'];

  it('no page verifies a credential without asking the limiter first', async () => {
    const { readFile } = await import('node:fs/promises');
    const { execFileSync } = await import('node:child_process');
    const tracked = execFileSync('git', ['ls-files', 'src'], { cwd: process.cwd(), env: cleanGitEnv(), encoding: 'utf8' }).trim().split('\n');

    const offenders: string[] = [];
    for (const file of tracked) {
      // The verifiers' own module is where they are defined, not called.
      if (file === 'src/lib/seller-auth.ts' || file === 'src/lib/admin-auth.ts') continue;
      const body = await readFile(file, 'utf8');
      const verifies = VERIFIERS.some((fn) => body.includes(`${fn}(`));
      if (verifies && !body.includes('checkAuthRate')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('retry wording', () => {
  it('rounds up and never promises an unlock that has not happened', () => {
    expect(retryAfterMinutes(1)).toBe(1);
    expect(retryAfterMinutes(61)).toBe(2);
    expect(retryAfterMinutes(900)).toBe(15);
  });
});
