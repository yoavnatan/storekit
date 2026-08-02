/**
 * The Postgres connection — one pool for the whole process.
 *
 * **Why a pool and not a connection per request (DB_MIGRATION_PLAN.md §7.16).** Opening a
 * Postgres connection is expensive (TCP + TLS + auth + a backend process on the server), and
 * Postgres caps how many may exist at once — a few hundred, far below our request rate. A Node
 * server that connects per request exhausts that cap within minutes of real traffic and every
 * later request fails with `too many clients`. That is the number-one cause of "worked in dev,
 * fell over in production", and it is prevented by configuration on day one, not after the fall:
 * a fixed-size pool hands the same small set of connections around, and a request that arrives
 * with all of them busy WAITS instead of opening a new one.
 *
 * `DB_POOL_MAX` therefore sizes concurrency, not capacity. It must stay below the provider's
 * limit divided by the number of app instances — with a managed pooler (Neon `-pooler`, pgBouncer)
 * in front, the provider multiplexes thousands of client connections onto few server ones, which
 * is what makes several instances safe.
 *
 * **The pool is lazy on purpose.** The app is mid-migration: most modules still read `data/*.json`
 * (DB_MIGRATION_PLAN.md §8 stage 2 replaces them one by one). Connecting at import time would make
 * `DATABASE_URL` mandatory for a repo that mostly does not need it yet, and would open a socket in
 * every unit test. Nothing connects until the first query.
 *
 * Configuration is read through `runtime-env.ts` — never `import.meta.env`, which is a build-time
 * text substitution and would bake a dev connection string into the production bundle.
 */
import pg from 'pg';
import { serverEnv } from './runtime-env.js';

const { Pool, types } = pg;

/**
 * `bigint` (`int8`) arrives as a STRING from the wire, because a Postgres bigint does not fit in
 * a JS number. Every money column is `*_agorot bigint` (§7.7), and all of ours are agorot counts
 * far below 2^53, so parsing to a number here keeps `money.ts` working on plain numbers. The cast
 * is deliberate and bounded: 2^53 agorot is ~90 trillion shekels. Row COUNTS come back through
 * this same cast, which is why `SELECT COUNT(*)` reads as a number and not `'42'`.
 */
types.setTypeParser(20, (value: string) => Number(value));

/**
 * `numeric` also arrives as a string. We store no money as `numeric` (§7.7 chose integer agorot),
 * so anything numeric here is an aggregate — leave it a string rather than silently losing
 * precision, and let the call site decide.
 */

let pool: pg.Pool | undefined;

/**
 * What one statement returns. `rowCount` is deliberately part of the contract and not an
 * afterthought: for the atomic stock decrement (§7.5) the number of affected rows IS the answer —
 * 1 means sold, 0 means there was not enough and the sale must be refused — and the same holds for
 * every `UPDATE … WHERE` that encodes a precondition.
 */
export interface QueryOutcome<Row> { rows: Row[]; rowCount: number }

/** The minimal surface every `lib/` module codes against — a pooled connection or a transaction. */
export interface Queryable {
  query<Row>(text: string, params?: readonly unknown[]): Promise<QueryOutcome<Row>>;
}

/** A whole database: statements, transactions, and a way to shut it down. */
export interface Database extends Queryable {
  transaction<T>(run: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * The database this process talks to — swappable, and that is the point.
 *
 * **Why this seam exists (DB_MIGRATION_PLAN.md §8 stage 2).** Stage 2 replaces `lib/*` module by
 * module, file read → query. The moment the first module flips, every test that touches it needs a
 * Postgres — and there are 120 test files. Requiring a running server to run `npm test` would mean
 * the suite stops being the quality gate the plan leans on (§9.1: "all tests pass unchanged"), on a
 * branch that stays broken in the middle for many sessions.
 *
 * `tests/helpers/test-db.ts` therefore installs PGlite here — Postgres compiled to WASM, in-process:
 * the same parser, planner and constraint machinery, which is what makes a green suite mean
 * something. The alternative, mocking each module, would test the mocks.
 *
 * It is also why `lib/` never imports a `pg` type. Modules take `Queryable`; only this file knows
 * the driver.
 */
let active: Database | undefined;

/**
 * Point every query in the process at `db` — tests only; pass `undefined` to go back to Postgres.
 *
 * Production never calls this: the default is the real pool, reached lazily, so a repo that has not
 * finished the migration still starts without `DATABASE_URL`.
 */
export function setDatabase(db: Database | undefined): void {
  active = db;
}

/** The database in force right now — the injected one, else the pooled Postgres connection. */
export function getDatabase(): Database {
  return active ?? poolDatabase;
}

/**
 * The real one. `rowCount` is `number | null` in `pg` (null for statements that return no count);
 * normalising it to 0 here means a caller reading the affected-row count never has to consider a
 * third case that cannot happen for the statements we run.
 */
const poolDatabase: Database = {
  async query<Row>(text: string, params: readonly unknown[] = []) {
    const result = await getPool().query(text, params as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  },
  transaction: withPooledTransaction,
  close: closePool,
};

/** The connection string, or undefined while this environment still runs on JSON files. */
export function databaseUrl(): string | undefined {
  return serverEnv('DATABASE_URL');
}

/** True when this environment is configured to talk to Postgres at all. */
export function isDbConfigured(): boolean {
  return Boolean(databaseUrl());
}

/**
 * TLS for the connection, and it VERIFIES the certificate by default.
 *
 * The convenient thing to write here is `rejectUnauthorized: false`, which every "just make it
 * connect" answer online suggests. It means the client accepts any certificate at all, which turns
 * an encrypted connection into one that is merely obfuscated: anything that can answer for the
 * database's hostname — a hijacked DNS answer, a machine on the path — is handed the credentials
 * and every row of the database, and nothing reports a problem. Neon, Supabase and RDS all present
 * certificates from public authorities Node already trusts, so verification simply works and there
 * is no reason to give it up.
 *
 * Two deliberate opt-outs, both spelled out in the connection string so they are visible in
 * configuration rather than hidden in code: `sslmode=disable` (local Postgres over plain TCP) and
 * `sslmode=no-verify` (a provider using a private CA — the escape hatch, not the default).
 *
 * Exported because `scripts/` runs under plain node and cannot import TypeScript, so the two
 * migration/import scripts carry their own copy in `scripts/lib/pg-connect.mjs`;
 * `tests/db-connect.test.ts` asserts the two agree so the copy cannot drift.
 */
export function sslSetting(connectionString: string): false | { rejectUnauthorized: boolean } {
  if (connectionString.includes('sslmode=disable')) return false;
  if (connectionString.includes('sslmode=no-verify')) return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

/**
 * Everything `pg` needs to connect — and the reason it is not simply `{ connectionString, ssl }`.
 *
 * **Measured, not assumed (2026-08-02):** when a connection string carries `sslmode=`, node-postgres
 * parses it and DISCARDS the `ssl` option passed beside it. `{ connectionString: '…?sslmode=require',
 * ssl: { rejectUnauthorized: false } }` resolves to full verification, and
 * `'…?sslmode=no-verify'` resolves to no verification — in both cases the explicit object is
 * ignored. So `sslSetting` above, on its own, decided nothing at all.
 *
 * Today's accident is the safe direction (`sslmode=require`, which every provider hands you, means
 * verify-full in `pg` 8). It is scheduled to stop being: `pg` warns that in v9 `require` adopts
 * libpq semantics — encrypt, do not verify — at which point a routine dependency bump would turn
 * certificate checking off across the application with no code change, no failing test and no error.
 *
 * Stripping `sslmode` and passing our own decision is what makes the rule real: the value below is
 * the value `pg` uses, in this version and the next. `tests/db-connect.test.ts` asserts that against
 * a genuine `pg.Client`, not against this function — the whole point is that the two can disagree.
 */
export function connectionConfig(rawUrl: string): { connectionString: string; ssl: false | { rejectUnauthorized: boolean } } {
  return { connectionString: stripSslMode(rawUrl), ssl: sslSetting(rawUrl) };
}

function stripSslMode(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const kept = url.slice(q + 1).split('&').filter((part) => part && !/^sslmode=/i.test(part));
  return kept.length ? `${url.slice(0, q)}?${kept.join('&')}` : url.slice(0, q);
}

function poolSize(): number {
  const configured = Number(serverEnv('DB_POOL_MAX'));
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 10;
}

/**
 * The process-wide pool, created on first use.
 *
 * The three timeouts are the difference between a slow query and an outage. Without
 * `statement_timeout` one runaway query holds a pooled connection forever; with a pool of 10, ten
 * of those take the whole site down while the database itself looks idle. `connectionTimeoutMillis`
 * makes a request waiting for a free connection fail fast instead of piling up, and `idleTimeout`
 * lets an over-provisioned pool shrink back so a scale-to-zero provider is not paid to stay awake.
 */
export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — this code path needs Postgres. See DB_MIGRATION_PLAN.md §2.1.');
  }
  pool = new Pool({
    ...connectionConfig(connectionString),
    max: poolSize(),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  // A pooled connection can die between uses (provider restart, idle reap). Without a listener
  // that surfaces as an unhandled 'error' event, which crashes the Node process.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

/** Run one statement. Parameters are `$1, $2, …` — never string-interpolate a value into SQL. */
export async function query<Row>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryOutcome<Row>> {
  return getDatabase().query<Row>(text, params);
}

/** The rows of one statement, which is what nearly every caller actually wants. */
export async function rows<Row>(text: string, params: readonly unknown[] = []): Promise<Row[]> {
  return (await query<Row>(text, params)).rows;
}

/** The first row, or undefined — for a lookup by primary key or unique column. */
export async function firstRow<Row>(
  text: string,
  params: readonly unknown[] = [],
): Promise<Row | undefined> {
  return (await query<Row>(text, params)).rows[0];
}

/**
 * Run several statements on ONE connection inside a transaction, committing on return and rolling
 * back on any throw.
 *
 * The callback receives the transaction and MUST use it — a top-level `query()` call inside the
 * callback goes to a different pooled connection and is therefore outside the transaction, which is
 * the classic way a "transactional" checkout half-commits.
 */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return getDatabase().transaction(fn);
}

async function withPooledTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const tx: Queryable = {
    async query<Row>(text: string, params: readonly unknown[] = []) {
      const result = await client.query(text, params as unknown[]);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the connection is already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool (tests, scripts, graceful shutdown). Safe to call when nothing ever connected. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const closing = pool;
  pool = undefined;
  await closing.end();
}
