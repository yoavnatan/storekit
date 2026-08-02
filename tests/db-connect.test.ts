/**
 * The database connection is encrypted AND the certificate is verified — asserted against a real
 * `pg.Client`, which is the only thing that settles it.
 *
 * **Why not just test our own function.** It was written first, and it did nothing: when a
 * connection string carries `sslmode=`, node-postgres parses that and DISCARDS the `ssl` option
 * passed beside it. `{ connectionString: '…?sslmode=require', ssl: { rejectUnauthorized: false } }`
 * came out as full verification and `'…?sslmode=no-verify'` came out as none — the explicit object
 * never applied either way. A test of the helper in isolation would have passed throughout.
 *
 * That accident currently lands on the safe side, and is scheduled to stop: `pg` warns that in v9
 * `sslmode=require` takes libpq semantics — encrypt, do not verify. A dependency bump would then
 * disable certificate checking everywhere, with no code change and nothing red. `connectionConfig`
 * strips `sslmode` so our decision is the one pg uses, and these assertions read the value pg
 * actually resolved.
 *
 * What it protects: `rejectUnauthorized: false` accepts ANY certificate, so the connection is
 * encrypted but unauthenticated — anything that can answer for the database's hostname is handed
 * the credentials and every row in it.
 */
import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { sslSetting as tsSsl, connectionConfig as tsConfig } from '../src/lib/db.js';
import { sslSetting as jsSsl, connectionConfig as jsConfig } from '../scripts/lib/pg-connect.mjs';

// No credentials in any of these on purpose. The connection is never opened — only PARSED — so a
// user/password pair would add nothing to the test while giving every secret scanner a hardcoded
// database password to warn about, and a warning nobody can act on is one people learn to skim.
const NEON = 'postgresql://ep-x-pooler.eu-central-1.aws.neon.tech/storekit?sslmode=require&channel_binding=require';
const BARE = 'postgresql://ep-x-pooler.eu-central-1.aws.neon.tech/storekit';
const LOCAL = 'postgres://localhost:5432/storekit?sslmode=disable';
const NO_VERIFY = 'postgres://private-host/storekit?sslmode=no-verify';

/**
 * What `pg` itself ends up using — not what we asked for.
 *
 * `connectionParameters` is the client's own resolved configuration. It is real and stable but not
 * in the published types (it is internal to the driver), which is exactly why reading it is the
 * point: the assertion has to see past our own arguments to the value the driver settled on.
 */
function resolved(rawUrl: string): unknown {
  const client = new pg.Client(tsConfig(rawUrl)) as unknown as { connectionParameters: { ssl: unknown } };
  return client.connectionParameters.ssl;
}

describe('database TLS', () => {
  it('verifies the certificate for a hosted database', () => {
    // The string a provider hands you (Neon's includes sslmode=require) and one with no sslmode.
    expect(resolved(NEON)).toEqual({ rejectUnauthorized: true });
    expect(resolved(BARE)).toEqual({ rejectUnauthorized: true });
  });

  it('honours the two explicit opt-outs, and only those', () => {
    expect(resolved(LOCAL)).toBe(false);                              // local Postgres, no TLS
    expect(resolved(NO_VERIFY)).toEqual({ rejectUnauthorized: false }); // private CA escape hatch
  });

  it('keeps every other connection parameter intact while removing sslmode', () => {
    const { connectionString } = tsConfig(NEON);
    expect(connectionString).not.toContain('sslmode');
    expect(connectionString).toContain('channel_binding=require');
    expect(tsConfig(BARE).connectionString).toBe(BARE);
    expect(tsConfig(LOCAL).connectionString).not.toContain('?');
  });

  it('is decided identically by the app and by the ops scripts', () => {
    // Two copies of one rule (a .mjs script cannot import .ts). This is what stops them drifting.
    for (const url of [NEON, BARE, LOCAL, NO_VERIFY]) {
      expect(jsSsl(url)).toEqual(tsSsl(url));
      expect(jsConfig(url)).toEqual(tsConfig(url));
    }
  });
});
