// Applies every pending file in migrations/ to the database in DATABASE_URL.
//
// Deliberately ~100 lines instead of a migration framework (Drizzle/Prisma/knex): what we need is
// "run these .sql files once, in order, and remember which ran". A framework would add a schema
// DSL, a generator and a lock-file to keep in sync with hand-written SQL we want to read literally
// — the index and constraint choices in DB_MIGRATION_PLAN.md §6/§7 are the point, and they should
// be visible as SQL, not generated from TypeScript.
//
//   npm run db:migrate          apply everything pending
//   npm run db:migrate -- --dry list what would run, touch nothing
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
import { createClient, requireDatabaseUrl } from './lib/pg-connect.mjs';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const dryRun = process.argv.includes('--dry');

const client = createClient(requireDatabaseUrl());

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

function pendingFiles(applied) {
  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];
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
  const pending = pendingFiles(applied);

  if (!pending.length) {
    console.log(`Nothing to do — ${applied.size} migration(s) already applied.`);
    return;
  }
  if (dryRun) {
    console.log(`${pending.length} pending:\n${pending.map((m) => `  · ${m.name}`).join('\n')}`);
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
