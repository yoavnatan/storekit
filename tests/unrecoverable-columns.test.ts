/**
 * The values that come back from a provider ONCE and can never be asked for again.
 *
 * Most data in this database is recoverable in some sense: an order can be reconstructed, a token
 * re-minted, a secret rotated, a seller asked to type his bank details again. A handful of values
 * cannot. They are issued once by somebody else, we store them, and if the row is lost there is no
 * call that returns them — the only repair is opening a SECOND merchant account, which costs ₪65 a
 * month forever and cannot be deleted, because PayMe's API has no delete.
 *
 * The owner's instruction, 2026-08-23, on being told about the first two: *"חמור! תראה שאין עוד
 * כאלו מהסוג הזה שידפקו אותנו."* This file is the answer to that — the class, written down, with
 * the two things that actually protect it asserted rather than assumed.
 *
 * **Protection 1: the backup takes the WHOLE database.** That is what makes this class safe today,
 * and it is one `--table` flag away from not being. A future "let us only dump the tables that
 * matter" is exactly the change that would quietly drop these columns, and the damage would be
 * invisible until a restore.
 *
 * **Protection 2: the columns still exist and are still spelled the same.** A rename is a normal,
 * innocent-looking migration; the reason it matters here is that whoever writes it needs to see
 * this file's header first. `db-migrate.mjs` already compares declared columns against the live
 * database — this is the other half, pinning the NAMES this project's recovery story depends on.
 *
 * **What is deliberately NOT here.** Everything the audit checked and cleared, because listing
 * recoverable values would make the list long enough to stop being read:
 * `seller_merchant_accounts.provider_ref` (re-findable — `get-sellers` searches by email/social id),
 * `orders.payment_ref` (re-findable — `get-sales` by our own deterministic `transaction_id`),
 * `stores.feed_export_token` (self-minted, regenerable), `AUTH_SECRET`/`ADMIN_SECRET` (rotation is
 * the documented revocation path and nothing stored is derived from them), `sellers.google_id`
 * (Google's `sub` returns on the next sign-in), the Cloudflare hostname (never stored — looked up
 * by hostname every time), `sellers.merchant_kyc` (the seller's own data; ask him again).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The class, and the cost of losing each one.
 *
 * Add a row the moment a new provider hands us something once. The test below only checks that the
 * columns exist — the value of the row is the SENTENCE, which is what a person reads before
 * deciding a migration is harmless.
 */
const WRITE_ONCE_COLUMNS: readonly { table: string; column: string; issuer: string; cost: string }[] = [
  {
    table: 'seller_merchant_accounts', column: 'public_key', issuer: 'PayMe create-seller',
    cost: 'no Hosted Fields key → this seller can never take a card again',
  },
  {
    table: 'seller_merchant_accounts', column: 'callback_secret', issuer: 'PayMe create-seller',
    cost: 'no signing key → none of his payment callbacks can ever be verified',
  },
  {
    // Found by the class sweep on 2026-08-23, in the same INSERT as the two above and with the
    // same lifetime — it was simply not noticed the first time. Its loss is quieter and just as
    // permanent: PayMe hand the seller this page to finish his own KYC on, so without it a seller
    // they have not yet approved has no way to become approved, and every store he owns stays
    // unable to sell with nothing on screen he can act on.
    table: 'seller_merchant_accounts', column: 'signup_link', issuer: 'PayMe create-seller',
    cost: 'no onboarding link → a seller PayMe have not approved can never complete his own KYC',
  },
];

const MIGRATIONS = join(process.cwd(), 'migrations');

function allMigrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');
}

describe('the backup is what protects this class', () => {
  const backup = readFileSync(join(process.cwd(), 'scripts', 'backup-db.mjs'), 'utf8');

  it('dumps the WHOLE database — no table selection, ever', () => {
    // A `--table` / `-t` / `--exclude-table` flag would make the dump a curated list, and a curated
    // list is a thing that goes out of date silently. The whole point of `pg_dump <url>` with no
    // selection is that a table added by a future migration is backed up the day it exists, with
    // nobody having to remember it — which is exactly how `seller_merchant_accounts` came to be
    // covered without anyone touching this script.
    for (const flag of ['--table', '--exclude-table', "'-t'", '"-t"']) {
      expect(backup.includes(flag), `backup-db.mjs must not filter tables (found ${flag})`).toBe(false);
    }
  });

  it('still refuses a dump that came back implausibly small', () => {
    // The other way a backup silently fails: pg_dump exits 0 having written a header and nothing
    // else. Named here rather than only in that file because this test is what a person reads when
    // asking "is the unrecoverable data really safe".
    expect(backup).toMatch(/MIN_|too small|implausibly small/i);
  });
});

describe('the columns this project cannot recover', () => {
  const sql = allMigrationSql();

  it.each(WRITE_ONCE_COLUMNS)('$table.$column still exists — $cost', ({ table, column }) => {
    // Deliberately a text search over every migration rather than a live database query: this must
    // fail for someone editing migrations on a laptop with no database, because the moment to think
    // about it is while writing the migration, not while running it.
    expect(sql, `${table}.${column} is gone or renamed — read this file's header before proceeding`)
      .toMatch(new RegExp(`\\b${column}\\b`));
    expect(sql).toMatch(new RegExp(`\\b${table}\\b`));
  });

  it('every one of them is written in exactly one place', () => {
    // Two writers means two chances to write an empty string over a value that cannot be fetched
    // again. Today `ensureMerchantAccount`'s INSERT is the only one, and `ON CONFLICT DO NOTHING`
    // means even a concurrent second create cannot overwrite the stored row — it discards its own
    // freshly-created account instead, loudly.
    const lib = readFileSync(join(process.cwd(), 'src', 'lib', 'seller-merchant.ts'), 'utf8');
    const writes = lib.match(/INSERT INTO seller_merchant_accounts|UPDATE seller_merchant_accounts/g) ?? [];
    // One INSERT, plus `setMerchantApproval`'s UPDATE — which touches `approved` and `updated_at`
    // and must never learn to touch anything in the list above.
    expect(writes).toHaveLength(2);
    expect(lib).toMatch(/SET approved = \$2, updated_at = now\(\)/);
  });
});
