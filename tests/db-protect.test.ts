/**
 * The guard that stands between a development session and the database somebody is looking at.
 *
 * `npm run db:migrate` used to apply whatever was pending to whatever `DATABASE_URL` pointed at.
 * That is fine every day until the day the shell is holding the connection string of the live
 * portfolio demonstration — a link on the owner's CV (memory `project_dezabin_stopped_job_search`)
 * — and then it is a schema change against a running deliverable, with no undo.
 *
 * The rule is the one `seed-db.mjs` already established for the seeders and this extends to
 * migrations: **the danger follows the connection string**, so the mark that stops it lives in the
 * database rather than in an environment variable that follows the person.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEMO_CLAIM_KEY,
  PROTECTED_CLAIM_KEY,
  protectedDatabaseReason,
  protectedRefusal,
} from '../scripts/lib/protected-db.mjs';
import { DEMO_CLAIM_KEY as SEEDER_DEMO_CLAIM_KEY } from '../scripts/lib/seed-db.mjs';
import { getDatabase, query } from '../src/lib/db.js';

const db = { query: (text: string, params?: unknown[]) => getDatabase().query(text, params) };

async function claim(key: string) {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify({ at: '2026-09-07T00:00:00.000Z' })],
  );
}

afterEach(async () => {
  await query('DELETE FROM app_settings WHERE key = ANY($1)', [[DEMO_CLAIM_KEY, PROTECTED_CLAIM_KEY]]);
});

describe('which databases refuse a migration', () => {
  it('an ordinary development database is not protected', async () => {
    expect(await protectedDatabaseReason(db)).toBeNull();
  });

  it('the mark written by db:protect protects it', async () => {
    await claim(PROTECTED_CLAIM_KEY);
    expect(await protectedDatabaseReason(db)).toBe('protected');
  });

  it("the portfolio demonstration's own claim protects it, with nobody having to say so", async () => {
    await claim(DEMO_CLAIM_KEY);
    expect(await protectedDatabaseReason(db)).toBe('demo');
  });

  it('names the demonstration first when a database is both', async () => {
    await claim(DEMO_CLAIM_KEY);
    await claim(PROTECTED_CLAIM_KEY);
    // The message a person reads should say the specific, alarming thing rather than the generic
    // one — "this is the live demo" stops a hand that "this is marked protected" might not.
    expect(await protectedDatabaseReason(db)).toBe('demo');
  });

  it('the key it reads is the key the seeder writes', () => {
    // Two files hold this string because `protected-db.mjs` must not drag the whole seeder in to
    // read one constant. This is what stops the copy from drifting into a guard that never fires.
    expect(DEMO_CLAIM_KEY).toBe(SEEDER_DEMO_CLAIM_KEY);
  });

  it('the refusal names the way through, or a person will delete the guard instead', () => {
    const text = protectedRefusal('demo', 'Applying 3 pending migration(s)', 'npm run db:migrate -- --live');
    expect(text).toContain('npm run db:migrate -- --live');
    expect(text).toContain('DATABASE_URL');
  });
});

describe('the guard is wired in front of the writes, not beside them', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'scripts/db-migrate.mjs'), 'utf8');

  it('checks protection before the loop that applies migrations', () => {
    // Not a source-text taste rule: the ONLY thing that makes this guard real is that it runs
    // before the first `client.query(sql)`. A refactor that moves the check below the loop leaves
    // every test above green while the migration has already been applied.
    const guardAt = source.indexOf('protectedDatabaseReason(client)');
    const applyAt = source.indexOf('for (const { name, sql, sum } of pending)');
    expect(guardAt, 'db-migrate.mjs no longer consults protectedDatabaseReason').toBeGreaterThan(-1);
    expect(applyAt, 'the apply loop was renamed — re-point this guard before trusting it').toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(applyAt);
  });

  it('lets --check and --dry through without the flag', () => {
    // A read-only run must never demand `--live`: `npm run verify` calls `db:migrate -- --check` on
    // every session, and a guard that fires there would be turned off within a day.
    const dryReturn = source.indexOf('if (dryRun) {');
    const guardAt = source.indexOf('protectedDatabaseReason(client)');
    expect(dryReturn).toBeGreaterThan(-1);
    expect(dryReturn).toBeLessThan(guardAt);
  });
});
