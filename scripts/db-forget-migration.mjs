#!/usr/bin/env node
/**
 * Forget ONE migration the ledger remembers and the repo does not have.
 *
 * ── The situation this exists for ──
 *
 * Every session on this machine shares one development database. A session that writes a migration,
 * applies it, and then stops without committing leaves `schema_migrations` naming a file no checkout
 * contains — and `db-migrate.mjs --check` refuses the whole tree over it, on every session, until
 * somebody clears it. That check is right to shout (a migration that is written but never applied
 * shipped a broken dev site on 2026-08-04) and it already prints the repair as raw SQL.
 *
 * Raw SQL is the problem. Pasting `DELETE FROM schema_migrations ...` into a `node -e` one-liner is
 * a destructive database write dressed as free text — the permission layer blocks it, correctly and
 * not always consistently, and the session that hit it is left explaining a paste to the owner. That
 * happened twice on 2026-08-17, which is what turned a one-off into this file. A named script with
 * ONE narrow job can be granted once and reasoned about; an arbitrary `node -e` can never be.
 *
 * ── The refusals are the point ──
 *
 * It will not remove a row whose FILE EXISTS in `migrations/` — that row is the record of a migration
 * that really did run, and deleting it means the next `db:migrate` runs it a second time. It takes
 * exactly one name per invocation and never a pattern, because "clear the stale ones" is how a ledger
 * gets emptied by a typo. And it never touches a table, a column or a row of anybody's data: the only
 * thing it can change is this database's memory of what has run.
 *
 * ── What it does NOT solve, deliberately ──
 *
 * The objects that migration created stay exactly where they are. That is correct for the case this
 * serves — the abandoned file is still on disk, so resuming that work re-runs it and its
 * `CREATE TABLE IF NOT EXISTS` finds what it made. Dropping tables is a different decision, with real
 * data on the other side of it, and it belongs to a person rather than to a convenience script.
 *
 *   npm run db:forget -- 0038_payment_intents.sql
 */
import { Client } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];

if (!name || name.startsWith('-')) {
  console.error('usage: npm run db:forget -- <migration-file-name.sql>');
  console.error('       removes ONE row from schema_migrations. Nothing else, ever.');
  process.exit(1);
}

// A pattern would be a way to empty the ledger with a typo. One name, spelled out.
if (/[%*?]/.test(name)) {
  console.error(`refusing "${name}" — one exact file name, never a pattern.`);
  process.exit(1);
}

// The whole safety property: a row whose file EXISTS records a migration that really ran, and
// forgetting it makes the next `db:migrate` run it again.
if (fs.existsSync(path.join(ROOT, 'migrations', name))) {
  console.error(`refusing: migrations/${name} exists in this checkout.`);
  console.error('This row is the record that it ran. Removing it would re-run the migration.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — nothing to do.');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rowCount } = await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
  if (rowCount === 0) {
    console.log(`nothing to forget — "${name}" is not in the ledger.`);
  } else {
    console.log(`forgot "${name}". Whatever it created is untouched, and so is any file that made it.`);
  }
} finally {
  await client.end();
}
