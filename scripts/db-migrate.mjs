// Applies every pending file in migrations/ to the database in DATABASE_URL.
//
// Deliberately ~100 lines instead of a migration framework (Drizzle/Prisma/knex): what we need is
// "run these .sql files once, in order, and remember which ran". A framework would add a schema
// DSL, a generator and a lock-file to keep in sync with hand-written SQL we want to read literally
// — the index and constraint choices in DB_MIGRATION_PLAN.md §6/§7 are the point, and they should
// be visible as SQL, not generated from TypeScript.
//
//   npm run db:migrate            apply everything pending
//   npm run db:migrate -- --dry   list what would run, touch nothing
//   npm run db:migrate -- --check same, but EXITS 1 if anything is pending — what `npm run verify`
//                                 runs, because writing a migration and forgetting to apply it is
//                                 invisible to every other check. The test suite builds its own
//                                 database from migrations/, so the whole suite stays green while
//                                 the running app throws `column X does not exist` on page load.
//                                 That happened on 2026-08-04 (migration 0008) and cost a broken
//                                 dev site; this flag is what makes it impossible to repeat.
//                                 With no DATABASE_URL it reports "skipped" and exits 0, so a
//                                 checkout without a database is not a failure.
//
// Rules this enforces:
//  · Each file runs inside ONE transaction — a migration that fails halfway leaves no partial
//    schema behind. (Postgres does DDL transactionally, unlike MySQL.)
//  · Applied files are recorded with a checksum. EDITING an already-applied migration is an
//    error, not a silent no-op: the database would no longer match the file, and the next
//    environment to run from scratch would get different tables. Fix forward with a new file.
//  · Ordering is by filename, so the NNNN_ prefix is what defines it. Never renumber.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClient, requireDatabaseUrl } from './lib/pg-connect.mjs';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const checkOnly = process.argv.includes('--check');
const dryRun = process.argv.includes('--dry') || checkOnly;

// `--check` is a gate that runs on every verify, including on a clone with no database configured.
// Demanding one there would make "I have not set up Postgres yet" look like a failing migration,
// so it reports the skip by name (verify's own rule: a check that did not run is always named).
if (checkOnly && !process.env.DATABASE_URL) {
  console.log('db migrations: skipped — no DATABASE_URL.');
  process.exit(0);
}

const client = createClient(requireDatabaseUrl());

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

/** Files on disk, in the order they run. */
function migrationFiles() {
  return fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];
}

/**
 * A ledger row naming a file that is NOT on disk — the other direction of the checksum rule, and
 * the one nothing was watching.
 *
 * It is not hypothetical: found on 2026-08-05 with 13 rows against 12 files. Two parallel sessions
 * both wrote `0010_*` (a worktree cannot isolate the next NUMBER — that is written down in the
 * parallel-sessions rules), the loser was renumbered to `0011_product_weight.sql`, and the ledger
 * kept the row for the `0010_product_weight.sql` that no longer exists. Harmless there only by luck:
 * the file was `ADD COLUMN IF NOT EXISTS`, so running it twice under two names did nothing the
 * second time.
 *
 * Why it must be loud rather than tidy-up-later: this database's history no longer matches any
 * checkout of the repo, so a fresh environment cannot be proven to reach the same schema — which is
 * the single thing this ledger exists to guarantee. Reported, never auto-deleted: only a person can
 * know whether the row is a renumbering to forget or a migration file somebody lost.
 *
 * ── "Not on disk" has to mean not in the REPO, not merely not in MY tree (owner, 2026-08-20) ──
 * Sessions run in parallel worktrees against ONE shared development database. So the moment any
 * session writes and applies a migration, every OTHER session's `verify` saw a ledger row whose file
 * is not in its own checkout, and went red — on work it did not do, cannot see and must not "fix"
 * (the suggested repair is a DELETE against the shared ledger, which would erase a live session's
 * migration). Guaranteed to fire, every time, for everyone: exactly the shape that has sessions
 * sitting unresponsive.
 *
 * A file that exists in a SIBLING worktree is not history drift — it is a colleague mid-flight, and
 * it will arrive here on the next merge. A file that exists in no tree at all is the real thing this
 * check was built for, and it still fails loudly. The distinction costs one directory read.
 */
function siblingMigrationNames() {
  // `git worktree list --porcelain` rather than a glob: it names every checkout of THIS repo,
  // including the main one from inside a worktree, and does not invent paths that were removed.
  // Absolute path, not `git` off PATH: this runs in a shell whose PATH a session can have altered,
  // and the answer decides whether another session's verify goes red. `/usr/bin/git` is present on
  // every machine this repo runs on; a failure to spawn is handled below as "no siblings", which is
  // the safe direction — it can only make the check STRICTER, never quieter.
  let out;
  try {
    out = execFileSync('/usr/bin/git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  } catch { return new Set(); }
  const names = new Set();
  for (const line of out.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = path.join(line.slice('worktree '.length).trim(), 'migrations');
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.sql')) names.add(f);
    } catch { /* a worktree without a migrations dir tells us nothing */ }
  }
  return names;
}

function orphanRows(applied) {
  const onDisk = new Set(migrationFiles());
  const elsewhere = siblingMigrationNames();
  return [...applied.keys()]
    .filter((name) => !onDisk.has(name) && !elsewhere.has(name))
    .sort();
}

function pendingFiles(applied) {
  const files = migrationFiles();
  const pending = [];
  for (const name of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    const sum = checksum(sql);
    const record = applied.get(name);
    if (!record) { pending.push({ name, sql, sum }); continue; }
    if (record !== sum) {
      throw new Error(
        `${name} was already applied but its contents changed (${record} → ${sum}).\n` +
          'An applied migration is history and cannot be edited — the database already ran the old\n' +
          'text, so a fresh environment would end up with a different schema. Add a new migration.',
      );
    }
  }
  return pending;
}

/**
 * ── The check the checksum guard cannot make: does the SCHEMA match what the files describe? ──
 *
 * `pendingFiles` watches the migration TEXT, and it is right about what it watches. It cannot see
 * the failure found on 2026-08-10: `seller_payouts` was missing `commission_agorot`, while 0023 —
 * the migration that declares it — was recorded as applied with a checksum that matched perfectly.
 * Nothing had been edited. The table simply already existed from an earlier attempt, so
 * `CREATE TABLE IF NOT EXISTS` skipped the entire statement including that column, and the ledger
 * recorded the run as successful because every statement really had run.
 *
 * The cost of not noticing was not cosmetic: `createPayout` INSERTs into that column, so the first
 * real payout run would have thrown on the day money was due to leave the company's account. The
 * tests could not have caught it — they build their own database from these same files, where the
 * column has always existed (memory `project_migration_not_applied_class`).
 *
 * ── What this parses, and what it deliberately does not ──
 * Column NAMES out of `CREATE TABLE [IF NOT EXISTS] x (…)` and `ALTER TABLE x ADD COLUMN [IF NOT
 * EXISTS] y`, compared against `information_schema`. Not types, not constraints, not indexes: a
 * missing column is the failure this class produces, it is the one a regex can find without
 * becoming a SQL parser, and a guard that tries to be a schema differ is a guard that cries wolf
 * and gets skipped. A column present with the wrong type is a different bug and this will not
 * catch it.
 *
 * Reported, never repaired: only a person can know whether the fix is a new migration or a
 * database that should be rebuilt.
 */
function declaredColumns() {
  const byTable = new Map();
  const add = (table, column) => {
    const key = table.toLowerCase();
    if (!byTable.has(key)) byTable.set(key, new Set());
    byTable.get(key).add(column.toLowerCase());
  };

  for (const name of migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')
      .replace(/--[^\n]*/g, '');   // line comments only; this file uses no block comments

    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi)) {
      const [, table, body] = m;
      for (const line of body.split('\n')) {
        // A column definition starts with an identifier; a table-level CONSTRAINT/PRIMARY KEY/
        // UNIQUE/CHECK/FOREIGN KEY clause starts with its keyword, and a continuation line is
        // indented past one level. Anything ambiguous is skipped rather than guessed at.
        const col = /^\s{2}([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(line);
        if (!col) continue;
        if (/^(constraint|primary|unique|check|foreign|exclude|like)$/i.test(col[1])) continue;
        add(table, col[1]);
      }
    }
    // ADDs and DROPs applied in the order they are WRITTEN, which is why they are collected and
    // sorted by offset rather than looped one kind at a time. Every ADD before any DROP reads a
    // file that re-adds a column it just dropped exactly backwards — 0027 drops `search_text` and
    // re-adds it with a new generation expression, and two passes concluded the column does not
    // exist, so drift silently stopped checking for it. Two regexes and not one alternation: the
    // merged pattern is past the complexity the linter allows, and these two are the originals.
    const adds = [...sql.matchAll(/ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)];
    const drops = [...sql.matchAll(/ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)];
    const columnOps = [
      ...adds.map((m) => ({ at: m.index, apply: () => add(m[1], m[2]) })),
      // A column the migrations later drop is not expected to be there.
      ...drops.map((m) => ({ at: m.index, apply: () => byTable.get(m[1].toLowerCase())?.delete(m[2].toLowerCase()) })),
    ].sort((a, b) => a.at - b.at);
    for (const op of columnOps) op.apply();
  }
  return byTable;
}

/** Columns the migrations declare and the database does not have. Tables absent entirely are left
 *  to `pendingFiles` — a database with no such table has migrations still to run, which is a
 *  different message. */
async function columnDrift() {
  const declared = declaredColumns();
  const { rows: live } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  const actual = new Map();
  for (const r of live) {
    if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
    actual.get(r.table_name).add(r.column_name);
  }

  const missing = [];
  for (const [table, columns] of declared) {
    const have = actual.get(table);
    if (!have) continue;
    for (const column of columns) if (!have.has(column)) missing.push(`${table}.${column}`);
  }
  return missing.sort();
}

async function main() {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));

  const orphans = orphanRows(applied);
  if (orphans.length) {
    console.error(
      `\nschema_migrations names ${orphans.length} migration(s) that are not in migrations/:\n` +
        orphans.map((n) => `  · ${n}`).join('\n') +
        '\n\nThis database ran something no checkout of the repo contains, so a fresh environment\n' +
        'cannot be shown to reach the same schema. Usually a renumbered migration (two sessions both\n' +
        'wrote the same number) — confirm the SQL really did land under its new name, then delete the\n' +
        "stale row: DELETE FROM schema_migrations WHERE name = '<name>';\n",
    );
    process.exitCode = 1;
  }

  const pending = pendingFiles(applied);

  // After the ledger checks and BEFORE deciding there is nothing to do — a database that is up to
  // date by name can still be wrong by shape, and that is the whole point of this one.
  const missing = await columnDrift();
  if (missing.length) {
    console.error(
      `\nmigrations/ declare ${missing.length} column(s) this database does not have:\n` +
        missing.map((c) => `  · ${c}`).join('\n') +
        '\n\nThe ledger says every migration ran, and it did — a CREATE TABLE IF NOT EXISTS whose\n' +
        'table already existed skips its whole body, columns included, and reports success. So the\n' +
        'file and the checksum both look right while the schema does not.\n' +
        'Fix it with a NEW migration (ALTER TABLE … ADD COLUMN IF NOT EXISTS …); never by editing\n' +
        'the one that was already applied.\n',
    );
    process.exitCode = 1;
  }

  if (!pending.length) {
    console.log(`Nothing to do — ${applied.size} migration(s) already applied.`);
    return;
  }
  if (dryRun) {
    console.log(`${pending.length} pending:\n${pending.map((m) => `  · ${m.name}`).join('\n')}`);
    // Naming the fix in the failure itself: the whole point is that the person who sees this is
    // the one who just wrote the migration and has no reason to suspect their database.
    if (checkOnly) {
      console.log('\nThe database is behind migrations/. Run: npm run db:migrate');
      process.exitCode = 1;
    }
    return;
  }

  for (const { name, sql, sum } of pending) {
    const started = Date.now();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, sum]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`${name} failed and was rolled back:\n  ${err.message}`, { cause: err });
    }
    console.log(`  applied ${name} (${Date.now() - started}ms)`);
  }
  console.log(`\n${pending.length} migration(s) applied.`);
}

main()
  .catch((err) => { console.error(`\n${err.message}\n`); process.exitCode = 1; })
  .finally(() => client.end());
