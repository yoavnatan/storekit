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
import { sslSetting as tsSsl, connectionConfig as tsConfig, connectWithWakeRetry, CONNECT_TIMEOUT_MESSAGES } from '../src/lib/db.js';
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

/**
 * Waking a suspended database, and the line between what may be retried and what may not.
 *
 * Neon suspends an idle compute to zero. The first request afterwards has to wake it, and the pool's
 * 5s `connectionTimeoutMillis` gives up first — which reached the error log twice on 2026-08-03 as a
 * 500 on `/` and on the seller dashboard, both immediately before `pg_postmaster_start_time()` says
 * the compute came back. Awake, a connection establishes in ~500ms.
 *
 * The retry is deliberately around connection ACQUISITION and nothing else, because that is the only
 * step that cannot have half-happened: no statement has been sent, so there is nothing to replay.
 * Retrying a query that failed after reaching the server could commit a write twice.
 */
describe('waking a suspended database', () => {
  const timeout = () => new Error(CONNECT_TIMEOUT_MESSAGES[0]);
  const never = () => false;
  const always = () => true;

  function attempts(results: Array<'ok' | Error>) {
    let i = 0;
    const calls: number[] = [];
    return {
      calls,
      connect: async () => {
        const outcome = results[i] ?? 'ok';
        calls.push(++i);
        if (outcome !== 'ok') throw outcome;
        return `client-${i}`;
      },
    };
  }

  it('does not retry what already worked', async () => {
    const a = attempts(['ok']);
    await expect(connectWithWakeRetry(a.connect, never)).resolves.toBe('client-1');
    expect(a.calls).toHaveLength(1);
  });

  it('retries a connect timeout once, and that second attempt is the wake-up', async () => {
    const a = attempts([timeout(), 'ok']);
    await expect(connectWithWakeRetry(a.connect, never)).resolves.toBe('client-2');
    expect(a.calls).toHaveLength(2);
  });

  it('gives up after ONE retry rather than stretching an outage', async () => {
    // Two retries would leave a visitor on a blank tab for fifteen seconds to learn what ten
    // already said.
    const a = attempts([timeout(), timeout(), 'ok']);
    await expect(connectWithWakeRetry(a.connect, never)).rejects.toThrow(CONNECT_TIMEOUT_MESSAGES[0]);
    expect(a.calls).toHaveLength(2);
  });

  it('does NOT retry when the pool is saturated — same error, opposite treatment', async () => {
    // This is the case the whole predicate exists for. A full pool means peers are queueing for a
    // slot; retrying queues again and doubles the wait, which is precisely the pile-up the
    // fail-fast timeout was chosen to prevent. Only an unsaturated pool is waiting on the SERVER.
    const a = attempts([timeout(), 'ok']);
    await expect(connectWithWakeRetry(a.connect, always)).rejects.toThrow(CONNECT_TIMEOUT_MESSAGES[0]);
    expect(a.calls, 'a saturated pool must fail fast').toHaveLength(1);
  });

  it('does not retry an error that is not a connect timeout', async () => {
    // Authentication failures, a bad database name, TLS refusal — none of them get better by asking
    // again, and one of them is how a misconfiguration is supposed to announce itself loudly.
    const a = attempts([new Error('password authentication failed'), 'ok']);
    await expect(connectWithWakeRetry(a.connect, never)).rejects.toThrow('password authentication');
    expect(a.calls).toHaveLength(1);
  });

  it('matches the message `pg` actually raises, not one we invented', async () => {
    // The driver attaches no code to this error, so the string is the only handle, and a driver
    // upgrade that reworded it would turn the retry into dead code with nothing failing.
    //
    // The address is deliberately one that HANGS rather than one that refuses: 198.51.100.0/24 is
    // TEST-NET-2 (RFC 5737), reserved for documentation and routed nowhere, so the connection
    // attempt goes unanswered and the timeout is the only way out. A refused port (127.0.0.1:1)
    // was tried first and is the wrong tool — it usually errors with ECONNREFUSED before the
    // timeout can fire, which made this assertion pass or skip itself depending on machine load.
    const pool = new pg.Pool({ host: '198.51.100.1', port: 5432, connectionTimeoutMillis: 60 });
    const message = await pool.connect().then(() => 'connected', (e: Error) => e.message);
    await pool.end().catch(() => { /* the pool never connected; nothing to drain */ });

    // **This assertion found a real hole.** The retry originally matched only the pool's own
    // "timeout exceeded when trying to connect". A server that never answers — a suspended compute,
    // which is the entire case the retry was written for — raises the SOCKET timeout instead, and
    // the retry would have been dead code in exactly that situation, silently.
    expect(message).toBe('Connection terminated due to connection timeout');
    expect(CONNECT_TIMEOUT_MESSAGES).toContain(message);
  });

  it('retries the SOCKET timeout too, which is the suspended-database case', async () => {
    const a = attempts([new Error('Connection terminated due to connection timeout'), 'ok']);
    await expect(connectWithWakeRetry(a.connect, never)).resolves.toBe('client-2');
    expect(a.calls).toHaveLength(2);
  });
});
