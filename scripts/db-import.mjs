// `npm run db:import` — load data/*.json into the database in DATABASE_URL, then prove it landed.
//
// The whole run is ONE transaction: a partial import is worse than none, because the count checks
// would then be comparing against a database somebody has already started using. Re-runnable, so
// fixing a problem and running again is the normal workflow (DB_MIGRATION_PLAN.md §8, stage 1).
import { createClient, requireDatabaseUrl } from './lib/pg-connect.mjs';
import { importAll } from './lib/db-import.mjs';
import { verifyImport, reportChecks } from './lib/verify-import.mjs';

const client = createClient(requireDatabaseUrl());

const started = Date.now();
await client.connect();

let report;
try {
  await client.query('BEGIN');
  report = await importAll(client);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
  console.error(`\nImport failed and was rolled back — the database is untouched.\n  ${err.message}\n`);
  process.exit(1);
}

const total = Object.values(report.counts).reduce((n, v) => n + v, 0);
console.log(`\nImported ${total} rows into ${Object.keys(report.counts).length} tables in ${Date.now() - started}ms:\n`);
for (const [table, n] of Object.entries(report.counts).sort()) console.log(`  ${String(n).padStart(6)}  ${table}`);

if (report.skipped.length) {
  // Never silent. A row that could not be written is the thing a later "the numbers look a bit
  // low" investigation needs to have been told about at the time.
  const byReason = new Map();
  for (const s of report.skipped) {
    const key = `${s.what} — ${s.reason.replace(/: .*$/, '')}`;
    byReason.set(key, (byReason.get(key) ?? 0) + s.count);
  }
  console.log(`\nSkipped ${report.skipped.reduce((n, s) => n + s.count, 0)} row(s):\n`);
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${reason}`);
}

console.log('\nVerifying (DB_MIGRATION_PLAN.md §9):\n');
const checks = await verifyImport(client, { skipped: report.skipped });
const ok = reportChecks(checks);
await client.end();
if (!ok) process.exit(1);
