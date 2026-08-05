/**
 * `/api/health` — the address an outside uptime monitor asks, and the only signal that survives the
 * two failures the in-app Alerts tab cannot report (process dead, database unreachable).
 *
 * Three claims are worth a test, and they are the three that would each turn the monitor into a
 * liar in a different direction: a healthy server must not answer 503 (a false alarm at 3am is how
 * a monitor gets muted, and a muted monitor is worse than none), a broken database must not answer
 * 200 (the failure it exists for, silently missed), and the cache must actually cap how often an
 * unauthenticated caller reaches the database.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database, Queryable } from '../src/lib/db.js';

/**
 * Re-imports the route so its module-level cache starts empty for each test — and hands back the
 * `setDatabase` from the SAME fresh module graph. `vi.resetModules()` gives the route a new copy of
 * `db.js`, so injecting through the top-level import would be configuring a different module than
 * the one the route ends up calling: every test would silently exercise "no database at all".
 */
async function freshRoute(db: Database) {
  vi.resetModules();
  const dbModule = await import('../src/lib/db.js');
  dbModule.setDatabase(db);
  const mod = await import('../src/pages/api/health.ts');
  return {
    GET: mod.GET as (ctx: unknown) => Promise<Response>,
    reset: () => dbModule.setDatabase(undefined),
  };
}

function countingDatabase(answer: () => Promise<{ rows: unknown[]; rowCount: number }>) {
  let calls = 0;
  const queryable: Queryable = {
    query: async () => {
      calls++;
      return answer() as never;
    },
  };
  const db: Database = {
    query: queryable.query,
    transaction: (run) => run(queryable),
    close: async () => {},
  };
  return { db, get calls() { return calls; } };
}

const ok = async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 });
const down = async () => { throw new Error('ECONNREFUSED'); };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('/api/health', () => {
  it('answers 200 while the database answers', async () => {
    const { GET } = await freshRoute(countingDatabase(ok).db);
    const res = await GET({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('answers 503 when the database does not answer — the case the Alerts tab cannot report', async () => {
    // A configured environment, i.e. every production one. Set here because the two 503s mean very
    // different things to whoever the alert wakes: a connection string that was never provided is
    // a deploy mistake, an unreachable database is an incident.
    vi.stubEnv('DATABASE_URL', 'postgres://example/db');
    const { GET } = await freshRoute(countingDatabase(down).db);
    const res = await GET({});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'degraded', checks: { database: 'down' } });
  });

  it('says not_configured, not down, when there is no connection string at all', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { GET } = await freshRoute(countingDatabase(down).db);
    expect(await (await GET({})).json()).toEqual({
      status: 'degraded',
      checks: { database: 'not_configured' },
    });
  });

  it('is never served from a cache by the caller or a proxy', async () => {
    const { GET } = await freshRoute(countingDatabase(ok).db);
    const res = await GET({});
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('hits the database at most once per cache window, however many callers arrive', async () => {
    // The route is unauthenticated and unrated. Without this cap, repeating the request is a way to
    // hold every connection in a 10-slot pool — the exact self-amplifying outage error-log.ts caps
    // itself against.
    const counting = countingDatabase(ok);
    const { GET } = await freshRoute(counting.db);
    for (let i = 0; i < 50; i++) await GET({});
    expect(counting.calls).toBe(1);
  });

  it('re-probes once the window has passed, so an incident is not cached forever', async () => {
    const counting = countingDatabase(ok);
    const { GET } = await freshRoute(counting.db);
    await GET({});

    // Past CACHE_MS (5s) — the value is duplicated rather than imported for the reason the other
    // guards duplicate theirs: changing it should have to be a decision, not an agreement.
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6_000);
    await GET({});
    expect(counting.calls).toBe(2);
  });
});

/**
 * The route answering 503 is worth nothing if the request never reaches it.
 *
 * `middleware.ts` runs before every route and does database work of its own — the custom-domain
 * lookup, then the page-view tap — so with Postgres unreachable it throws first and the health
 * route is replaced by a 500 HTML error page. The endpoint would then be broken in exactly and
 * only the situation it exists for, and nothing in the route's own tests could ever show it.
 *
 * Asserted against the source rather than by booting a server because that is what regresses: the
 * short-circuit is one line, and the way it dies is somebody adding a lookup ABOVE it. The
 * ordering is the invariant, so the ordering is what is checked.
 */
describe('middleware lets /api/health through before any database work', () => {
  const source = readFileSync(join(process.cwd(), 'src/middleware.ts'), 'utf8');

  it('returns early on the health path', () => {
    expect(source).toContain('if (pathname === HEALTH_PATH) return next();');
  });

  it('does so before the first database call in the request path', () => {
    const shortCircuit = source.indexOf('if (pathname === HEALTH_PATH) return next();');
    expect(shortCircuit).toBeGreaterThan(-1);

    // Every awaited lookup the middleware makes on the way to a route. A new one added above the
    // short-circuit fails here, which is the whole point of listing them by name.
    for (const call of ['getStoreByCustomDomain(', 'getStoreBySlug(', 'getProductBySlug(', 'recordPageViewTap(']) {
      const at = source.indexOf(call, source.indexOf('export const onRequest'));
      if (at === -1) continue; // renamed or removed — the other assertions still hold
      expect.soft(at, `${call} runs before the /api/health short-circuit`).toBeGreaterThan(shortCircuit);
    }
  });

  it('does NOT jump the CSRF gate', () => {
    // The gate is the one place this application checks a token, and an exemption granted here
    // would be inherited by whatever handler someone adds to the route later. It costs a set lookup
    // and an HMAC — no database — so it can stay in front without weakening the outage resilience
    // the short-circuit exists for.
    const gate = source.indexOf('return csrfRejection();');
    const shortCircuit = source.indexOf('if (pathname === HEALTH_PATH) return next();');
    expect(gate).toBeGreaterThan(-1);
    expect(shortCircuit).toBeGreaterThan(gate);
  });
});
