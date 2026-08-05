export const prerender = false;
import type { APIRoute } from 'astro';
import { query, isDbConfigured } from '../../lib/db.js';

/**
 * The one thing an outside watcher can ask this server: are you actually able to serve?
 *
 * **The gap it closes.** Everything else we have for knowing something is wrong reports from
 * INSIDE: `middleware.ts` catches a 500 and `error-log.ts` writes it to Postgres, where the admin
 * Alerts tab reads it. That chain is blind to precisely the two failures worth waking up for — the
 * process is dead (nothing runs, so nothing is logged) and the database is unreachable (the log
 * itself cannot be written, and the dashboard that would show it cannot render). In both cases the
 * admin panel is not a monitor, it is another casualty. Only something outside the box can tell
 * you, and something outside the box needs an address to ask. This is the address.
 *
 * **The status code is the whole interface.** 200 = serving, 503 = not. Uptime monitors alert on
 * the code, so nothing about the alert depends on parsing the body. The body exists so that when
 * the phone buzzes at 2am the first question — which half is down — is already answered.
 *
 * **Why it names the database in the body.** Nothing is leaked by it: when Postgres is unreachable
 * every page on the site is a 500, so "the database is down" is not a secret this endpoint gives
 * away. What it saves is the trip to the dashboard that is also down.
 *
 * **Deliberately not here.** No auth: a monitor cannot log in, and there is nothing to protect —
 * see above. No version, build id, or environment: those are real internals and no monitor needs
 * them. No "draining" state for a rolling deploy: there is one instance and no load balancer to
 * take it out of rotation, and inventing the flag now would be inventing its meaning too.
 */

/**
 * How long one probe's answer is reused. This is the whole defence for an endpoint that is
 * unauthenticated, unrated, and touches the database — the two properties that, together, are
 * normally how you hand someone a way to drain a 10-connection pool for free. With the cache, the
 * database sees at most one `SELECT 1` every five seconds no matter how many callers arrive, so
 * flooding this route costs an attacker exactly as much as flooding a static file.
 *
 * Five seconds is chosen against the consumer: monitors poll on the order of a minute, so a cached
 * answer is never the one being reported, and an incident is still visible within one poll.
 *
 * The cache is per process and holds no shared write state — it is this instance answering about
 * itself, which is the only thing it can honestly answer about, so a second instance behind a load
 * balancer stays correct with no coordination.
 */
const CACHE_MS = 5_000;

/**
 * This route's own path, declared here and imported by `middleware.ts`, which must let it through
 * untouched — see the note there. Exported from the route so the two can never disagree: a path
 * spelled twice is a path that gets renamed once.
 */
export const HEALTH_PATH = '/api/health';

interface Health {
  status: 'ok' | 'degraded';
  checks: { database: 'ok' | 'down' | 'not_configured' };
}

let cached: { at: number; body: Health } | null = null;

async function probe(): Promise<Health> {
  try {
    // The cheapest statement Postgres has. It is not testing our schema — it is testing that a
    // connection can be taken from the pool and answered, which is what every real request needs
    // first and what a sleeping or saturated database fails at. `db.ts` already bounds how long
    // that may take (`connectionTimeoutMillis` 5s, `statement_timeout` 15s), so this cannot hang.
    await query('SELECT 1');
    return { status: 'ok', checks: { database: 'ok' } };
  } catch {
    // The config check runs only to EXPLAIN a failure, never to predict one. Asked first it would
    // be answering from `DATABASE_URL` — an environment variable, not the database — and would
    // report a missing URL on a server that is in fact connected (`setDatabase` injects one), or
    // a present URL as proof of health. The query is the only real evidence; this just says which
    // of the two very different problems to go fix.
    return { status: 'degraded', checks: { database: isDbConfigured() ? 'down' : 'not_configured' } };
  }
}

export const GET: APIRoute = async () => {
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS) {
    cached = { at: now, body: await probe() };
  }
  const body = cached.body;
  return new Response(JSON.stringify(body), {
    status: body.status === 'ok' ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      // A monitor asking "are you up" must never be answered by a cache, ours or a proxy's — the
      // one reading that matters is the live one. `CACHE_MS` above is a different thing: it bounds
      // what this server does to the database, not what it tells the caller.
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
};
