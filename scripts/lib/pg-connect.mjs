// One Postgres client for the ops scripts (db-migrate, db-import).
//
// This is a deliberate second copy of the TLS rule in `src/lib/db.ts#sslSetting`: these scripts run
// under plain `node`, which cannot import TypeScript, and the alternative — a build step just to
// run a migration — is worse than a copy that is guarded. `tests/db-connect.test.ts` asserts the
// two implementations agree on every mode, so the copy cannot silently drift.
//
// The rule itself, and why `rejectUnauthorized: false` is not an acceptable default, is documented
// at length on the TypeScript original. Short version: it accepts ANY certificate, so an encrypted
// connection becomes merely an obfuscated one and anything that can answer for the database's
// hostname is handed every row.
import pg from 'pg';

/** @param {string} connectionString */
export function sslSetting(connectionString) {
  if (connectionString.includes('sslmode=disable')) return false;
  if (connectionString.includes('sslmode=no-verify')) return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

/**
 * `sslmode` is REMOVED from the string we hand to pg, and the decision passed separately.
 *
 * Not tidiness: when the string carries `sslmode=`, pg parses it and discards the `ssl` option
 * given beside it — so the function above would decide nothing. Measured, and documented at
 * length on the TypeScript original (`src/lib/db.ts#connectionConfig`).
 *
 * @param {string} rawUrl
 */
export function connectionConfig(rawUrl) {
  const q = rawUrl.indexOf('?');
  const connectionString = q === -1 ? rawUrl : (() => {
    const kept = rawUrl.slice(q + 1).split('&').filter((part) => part && !/^sslmode=/i.test(part));
    return kept.length ? `${rawUrl.slice(0, q)}?${kept.join('&')}` : rawUrl.slice(0, q);
  })();
  return { connectionString, ssl: sslSetting(rawUrl) };
}

/**
 * The connection string, or exit with instructions. A script that starts work and only then finds
 * it has nowhere to write is a script that leaves a half-migrated database.
 */
export function requireDatabaseUrl() {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) return connectionString;
  console.error(
    '\nDATABASE_URL is not set.\n\n' +
      '  Local:      docker compose up -d db\n' +
      '              DATABASE_URL=postgres://storekit:storekit@localhost:5432/storekit?sslmode=disable\n' +
      '  Production: the POOLED Neon connection string (its host contains "-pooler").\n\n' +
      'See .env.example and DB_MIGRATION_PLAN.md §2.1.\n',
  );
  process.exit(1);
}

/** A single connected client for a one-shot script. Scripts do not need a pool. */
export function createClient(rawUrl) {
  return new pg.Client(connectionConfig(rawUrl));
}
