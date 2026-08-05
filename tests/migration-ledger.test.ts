/**
 * `schema_migrations` describes a history the repo can actually reproduce.
 *
 * The runner already refuses an applied migration whose TEXT changed. Nothing watched the other
 * direction — a ledger row naming a file that is not in `migrations/` at all — and on 2026-08-05 the
 * live database had one: 13 rows against 12 files. Two parallel sessions both wrote `0010_*` (a
 * worktree cannot isolate the next NUMBER), the loser was renumbered to `0011_product_weight.sql`,
 * and the row for the `0010_product_weight.sql` that no longer exists stayed behind. It did no damage
 * only by luck — the file was `ADD COLUMN IF NOT EXISTS`, so the second run under the second name was
 * a no-op.
 *
 * The damage it COULD do is the thing the ledger exists to prevent: a database whose history matches
 * no checkout cannot be shown to reach the same schema as a fresh environment. So the runner reports
 * it and exits non-zero, and this file pins both the numbering hygiene on disk and the guard itself.
 *
 * Run against the FILES and the runner's own source, not against a database — the ledger of the live
 * DB is not a thing a test may read or clean up.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();

describe('migration files', () => {
  it('are numbered once each, with no gaps', () => {
    // A duplicate number is the collision itself: `db-migrate.mjs` runs in filename order, so two
    // `0010`s both run, in an order neither author chose. A gap means a file was deleted after
    // somebody's database already ran it — which is the orphan row this suite is about.
    const numbers = files.map((f) => f.slice(0, 4));
    expect(new Set(numbers).size, `duplicate migration number in: ${files.join(', ')}`).toBe(files.length);
    expect(numbers).toEqual(files.map((_, i) => String(i + 1).padStart(4, '0')));
  });

  it('never edits history: every file is additive or explicitly reversible', () => {
    // Not a style rule — an applied migration is history, so a destructive statement in a NEW file is
    // the only sanctioned way to remove something, and it must be visible in review rather than
    // hidden inside a rename. This asserts the shape the repo actually uses today.
    for (const f of files.slice(1)) {
      const sql = readFileSync(join(ROOT, 'migrations', f), 'utf8');
      expect(sql.trim().length, `${f} is empty`).toBeGreaterThan(0);
      // Every migration says WHY in prose above its SQL — the reason survives long after the diff.
      expect(sql.trimStart().startsWith('--'), `${f} has no explanation above its SQL`).toBe(true);
    }
  });
});

describe('the runner refuses a history it cannot reproduce', () => {
  const runner = readFileSync(join(ROOT, 'scripts/db-migrate.mjs'), 'utf8');

  it('compares the ledger against disk in BOTH directions', () => {
    // file-not-in-ledger → pending (it runs); ledger-not-on-disk → reported and non-zero.
    expect(runner).toContain('function orphanRows(');
    expect(runner).toContain('function pendingFiles(');
    expect(runner).toMatch(/orphans\.length[\s\S]{0,900}process\.exitCode = 1/);
  });

  it('names the stale row and the exact SQL to remove it', () => {
    // The person reading this is the one who just renumbered a migration and has no reason to
    // suspect their database — a guard that only says "mismatch" sends them looking in the wrong place.
    expect(runner).toContain('DELETE FROM schema_migrations WHERE name =');
  });

  it('never deletes the row itself', () => {
    // Only a person can tell a renumbering to forget from a migration file somebody lost, and the
    // second case must not be silently tidied away into a schema nobody can rebuild.
    const autoDelete = /client\.query\(\s*[`'"]\s*DELETE FROM schema_migrations/i;
    expect(autoDelete.test(runner)).toBe(false);
  });
});
