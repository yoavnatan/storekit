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
import { migrationFileName } from '../scripts/db-new-migration.mjs';

const ROOT = process.cwd();
const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();

/**
 * ── Two naming eras, and why the counter had to end (2026-08-18) ──
 *
 * `0001…0041` came from ONE global counter, and this repo runs several sessions at once in separate
 * worktrees. **A worktree isolates files; it does not isolate a counter.** Two sessions writing a
 * migration on the same afternoon both saw the same last number and both wrote the next one — not a
 * mistake either could avoid. The header above records it happening at `0010` on 2026-08-05; it
 * happened again at `0038` on 2026-08-17 and cost the owner an evening, because by then the loser's
 * file was applied in the SHARED development database, so every other session's `--check` refused the
 * whole tree until somebody cleared a ledger row by hand.
 *
 * New migrations are timestamped to the second (`npm run db:new`). Two sessions cannot collide unless
 * they run that command in the same second, and then the second one is told. The run ORDER is
 * unchanged, which is why this was safe to do: the runner sorts filenames, `0…` sorts before `2…`,
 * and timestamps sort chronologically among themselves.
 *
 * The 41 numbered files keep their names forever. Renaming an applied migration orphans its ledger
 * row on every machine that ran it — the precise failure this whole file exists to catch.
 */
const LEGACY = /^\d{4}_/;
const STAMPED = /^\d{8}_\d{6}_[a-z0-9_]+\.sql$/;
/** Frozen: the last number ever issued. A 42nd numbered file is the collision coming back. */
const LEGACY_COUNT = 41;

describe('migration files', () => {
  it('the numbered era is closed — new migrations are timestamped', () => {
    const legacy = files.filter((f) => LEGACY.test(f));
    expect(
      legacy.length,
      'a new NNNN_ migration was added. That counter is why two sessions collided three times —\n'
      + '  use `npm run db:new -- <name>` instead, which stamps the file with the time to the second.',
    ).toBe(LEGACY_COUNT);
  });

  it('the numbered ones are still unique and gapless — they are frozen history', () => {
    // Unchanged for the legacy set, and still worth asserting: a gap here means a file was deleted
    // after somebody's database already ran it, which is the orphan row this suite is about.
    const numbers = files.filter((f) => LEGACY.test(f)).map((f) => f.slice(0, 4));
    expect(new Set(numbers).size, `duplicate migration number in: ${files.join(', ')}`).toBe(numbers.length);
    expect(numbers).toEqual(numbers.map((_, i) => String(i + 1).padStart(4, '0')));
  });

  it('every timestamped one is well formed and unique', () => {
    const stamped = files.filter((f) => !LEGACY.test(f));
    for (const f of stamped) {
      expect(STAMPED.test(f), `${f}: expected YYYYMMDD_HHMMSS_name.sql — create it with \`npm run db:new\``).toBe(true);
    }
    // Same second, same name: the generator refuses it, and this catches one written by hand.
    const stamps = stamped.map((f) => f.slice(0, 15));
    expect(new Set(stamps).size, `two migrations share a timestamp: ${stamped.join(', ')}`).toBe(stamped.length);
  });

  it('the generator produces exactly the shape this file demands', () => {
    // The one assertion that ties two deliberately-separate statements of the rule together. The
    // regex above is independent ON PURPOSE — its job is to catch a file somebody named by hand, and
    // a guard that reads its rule from the generator asserts nothing. This is what stops a rename in
    // the generator from quietly outdating it: they may be written twice, but they must agree.
    const made = migrationFileName('Return Admin Award!!', new Date(2026, 7, 18, 21, 42, 33));
    expect(made).toBe('20260818_214233_return_admin_award.sql');
    // Narrowed rather than asserted with `!`: a null here would otherwise stringify into the regex
    // test as "null" and pass both of the next two lines while meaning the generator had refused.
    expect(made).not.toBe(null);
    expect(STAMPED.test(made ?? '')).toBe(true);
    expect(LEGACY.test(made ?? '')).toBe(false);
    // A name with nothing usable in it is refused rather than turned into a file called `.sql`.
    expect(migrationFileName('!!!')).toBe(null);
    // And a path separator cannot survive the normalisation — the name reaches the filesystem.
    expect(migrationFileName('../../etc/passwd')).toMatch(/^\d{8}_\d{6}_etc_passwd\.sql$/);
  });

  it('runs oldest-first whatever the era — the sort the runner relies on', () => {
    // The one property that made the switch safe, pinned rather than assumed: legacy names sort
    // before timestamped ones because '0' < '2'. If a future era ever starts with a '0' or a '1',
    // this fails instead of silently re-ordering history.
    const legacy = files.filter((f) => LEGACY.test(f));
    const stamped = files.filter((f) => !LEGACY.test(f));
    if (legacy.length > 0 && stamped.length > 0) {
      expect([...legacy, ...stamped]).toEqual([...files].sort());
    }
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
