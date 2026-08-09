// Take a full logical dump of the production database and put it somewhere Neon cannot reach.
//
// **Why this exists at all, in one paragraph.** Neon's Free plan keeps 6 hours of change history
// (their own plan page, checked 2026-08-09). Six hours covers "I broke something and noticed while
// still at the keyboard" and covers nothing else — a mistake made in the evening and found in the
// morning is already unrecoverable. It also dies with the account: a lapsed card, a suspension or a
// deleted project takes the restore window with it, because it lives inside the thing being
// restored. `data/*.json` were deleted on 2026-08-03 and `db:import` was deleted with them, on
// purpose, so nothing else in this project holds a second copy of an order. This script is the
// second copy. GO_LIVE §6 carries the owner-facing version.
//
// **Where it runs, and why not here.** `pg_dump` is a binary, and the machine this was written on
// has neither it nor Docker — which is the useful fact, not an inconvenience: a weekly backup that
// depends on one laptop being awake is not a backup. It runs in GitHub Actions
// (`.github/workflows/backup.yml`), where `pg_dump` is preinstalled, the schedule is not ours to
// keep, and the credentials are GitHub secrets rather than a file on a desk. Nothing here is
// GitHub-specific though — it reads environment variables and shells out, so a host with a cron
// runs it unchanged.
//
// **The dump format is plain SQL, gzipped, and that is a decision.** `--format=custom` is smaller
// and restores selectively, but it can only be read by a `pg_restore` of a compatible version. Plain
// SQL is readable by any Postgres, by any text tool, and by a person at 2am who is not sure what
// they are looking at. For a backup — a file whose whole value is being usable under conditions
// nobody planned for — legibility beats every other property.
//
// **`--no-owner --no-acl`:** role names are environment-specific (`REVOKE` on `money_events` in
// GO_LIVE §6 says so explicitly), and a dump that carries them fails to restore anywhere the roles
// do not exist — which is precisely the situation a restore happens in.
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { putObject, getObject, sha256 } from './lib/s3-put.mjs';

/**
 * The dump binary, as an ABSOLUTE path and never as a name looked up on `PATH`.
 *
 * A bare `pg_dump` is resolved by whatever `PATH` says at the moment it runs, so anything that can
 * put a file earlier on that path decides what reads the production database and where its output
 * goes. On a CI runner that is not a hypothetical: `PATH` there includes writable, tool-managed
 * directories.
 *
 * **`/usr/bin/pg_dump` is only the fallback, and the workflow deliberately does not use it.** It is
 * a `postgresql-common` wrapper that chooses a version by its own rules, and on the ubuntu runner it
 * kept choosing the preinstalled 16 even with 18 installed alongside — so the first real run failed
 * with `server version: 18.4 … pg_dump version: 16.14` (2026-08-09). The workflow therefore sets
 * `PG_DUMP_PATH` to the versioned binary. The lesson generalises past CI: installing the right
 * client and running it are two different things, and only the second one is checkable.
 *
 * `PG_DUMP_PATH` also covers a local run, where Homebrew puts it somewhere else entirely
 * (`/opt/homebrew/opt/libpq/bin/pg_dump`). Overriding is a deliberate act; inheriting is not.
 */
const PG_DUMP = process.env.PG_DUMP_PATH || '/usr/bin/pg_dump';

/** Required, and reported together: a run that stops at the first missing variable makes the
 *  operator find them one failed run at a time. */
const REQUIRED = ['DATABASE_URL', 'R2_ACCOUNT_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BACKUP_BUCKET'];

/** Refuse a dump that is implausibly small instead of uploading it.
 *
 *  This is the failure this script is most likely to have, and the one that hurts most: `pg_dump`
 *  can exit 0 having written only a header — an empty schema, a connection that resolved to the
 *  wrong database, a permission that hides every table. The result is a file, on a schedule, with a
 *  green log, containing nothing. The floor is deliberately crude; it is not checking that the dump
 *  is *right*, only that a dump of a database with dozens of tables cannot be this size. */
const MIN_PLAUSIBLE_BYTES = 20_000;

function missingEnv() {
  return REQUIRED.filter((name) => !process.env[name]);
}

/** Run pg_dump and collect stdout. Rejects on a non-zero exit with whatever it said on stderr —
 *  pg_dump's diagnostics are specific and losing them turns every failure into "it did not work". */
function runPgDump(databaseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(PG_DUMP, [
      '--no-owner',
      '--no-acl',
      // Quote every identifier and never depend on the client's search_path — the schema has
      // Hebrew data but ASCII identifiers, and this keeps the file loadable by a psql that was
      // started with different settings than the one that wrote it.
      '--quote-all-identifiers',
      databaseUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => reject(new Error(
      e.code === 'ENOENT'
        ? `pg_dump was not found at ${PG_DUMP}. This script is meant to run in CI (.github/workflows/backup.yml), where it is installed there; locally, \`brew install libpq\` provides it and PG_DUMP_PATH points at it.`
        : `pg_dump could not start: ${e.message}`,
    )));
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      reject(new Error(`pg_dump exited ${code}: ${Buffer.concat(err).toString().slice(0, 1000)}`));
    });
  });
}

/**
 * `dezabin-2026-08-09T12-15-00Z.sql.gz` — sorts chronologically as text, carries the instant it was
 * taken, and has no colons (S3 keys allow them; Windows filenames do not, and a restore should not
 * be blocked by where the file was downloaded).
 */
export function backupKey(date) {
  return `dezabin-${date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}.sql.gz`;
}

async function main() {
  const missing = missingEnv();
  if (missing.length) {
    console.error(`backup-db: missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const startedAt = new Date();
  console.log(`backup-db: dumping…`);
  const sql = await runPgDump(process.env.DATABASE_URL);
  if (sql.byteLength < MIN_PLAUSIBLE_BYTES) {
    throw new Error(`backup-db: refusing to upload — the dump is ${sql.byteLength} bytes, below the ${MIN_PLAUSIBLE_BYTES}-byte floor. An empty or near-empty dump means pg_dump succeeded against the wrong database or saw no tables; uploading it would overwrite nothing but would report success.`);
  }
  const body = gzipSync(sql, { level: 9 });
  const key = backupKey(startedAt);
  console.log(`backup-db: ${sql.byteLength} bytes SQL → ${body.byteLength} gzipped → ${key}`);

  const creds = {
    endpoint: process.env.R2_ACCOUNT_ENDPOINT,
    bucket: process.env.R2_BACKUP_BUCKET,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  };
  await putObject({ ...creds, key, body, contentType: 'application/gzip' });

  // Read the whole object back and hash it. A 200 on the PUT says the request was accepted; only
  // this says the bytes are retrievable and identical — which is the entire claim a backup makes.
  // `s3-put.mjs#getObject` carries why the two cheaper checks (by size, by ETag) are both traps.
  const stored = await getObject({ ...creds, key });
  if (!stored) throw new Error(`backup-db: uploaded ${key} but reading it back found nothing — treat this backup as failed.`);
  if (sha256(stored) !== sha256(body)) {
    throw new Error(`backup-db: ${key} reads back as ${stored.byteLength} bytes that do not match the ${body.byteLength} we sent — treat this backup as failed.`);
  }

  console.log(`backup-db: verified ${key} — ${body.byteLength} bytes, read back and matched, in ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s`);
}

// Only when run directly, so the tests can import `backupKey` without taking a dump.
if (process.argv[1] && process.argv[1].endsWith('backup-db.mjs')) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
