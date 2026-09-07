/**
 * Is the database on the other end of this connection one that must not be changed casually?
 *
 * **The danger follows the connection string, never the environment.** That rule is already written
 * out at length in `seed-db.mjs` (`isDemoDatabase`) and this is the same rule applied to the other
 * destructive path: `DEMO_MODE` travels with a shell and follows the person, while `DATABASE_URL`
 * is what actually decides which rows get altered. A session that exports the right variable and
 * the wrong URL is the accident this exists to stop.
 *
 * Two keys mark a database, and either is enough:
 *
 *  · `demo_database`      — written by `seed-portfolio.mjs --claim`. The live portfolio
 *                           demonstration, which is a link on the owner's CV
 *                           (memory `project_dezabin_stopped_job_search`): breaking it breaks a
 *                           deliverable, so it is protected without anybody having to say so again.
 *  · `protected_database` — written by `npm run db:protect`. For any other connection that must not
 *                           be migrated by accident — production, when there is one.
 *
 * What this does NOT do is decide anything on its own. It reports; the caller refuses. A guard that
 * silently downgrades an operation is worse than one that stops and names the reason.
 */

/** Written by `npm run db:protect`, read here and nowhere else. */
export const PROTECTED_CLAIM_KEY = 'protected_database';

/** Written by `seed-portfolio.mjs --claim`; kept in sync with `seed-db.mjs#DEMO_CLAIM_KEY`, which
 *  cannot be imported here without dragging the whole seeder in for one string. `tests/db-protect.test.ts`
 *  fails if the two ever disagree. */
export const DEMO_CLAIM_KEY = 'demo_database';

/**
 * Why this database is protected, or `null` if it is not.
 *
 * Returns `null` rather than throwing when `app_settings` does not exist: a database so young it
 * has not run 0001 yet is exactly the database a migration SHOULD run against, and demanding the
 * table would make the first migration of a fresh environment impossible.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }} db
 * @returns {Promise<'demo' | 'protected' | null>}
 */
export async function protectedDatabaseReason(db) {
  let rows;
  try {
    ({ rows } = await db.query('SELECT key FROM app_settings WHERE key = ANY($1)', [
      [DEMO_CLAIM_KEY, PROTECTED_CLAIM_KEY],
    ]));
  } catch {
    return null;
  }
  const keys = new Set(rows.map((r) => r.key));
  if (keys.has(DEMO_CLAIM_KEY)) return 'demo';
  if (keys.has(PROTECTED_CLAIM_KEY)) return 'protected';
  return null;
}

/** The refusal text, kept beside the reason so every caller says the same thing and names the way
 *  through. `what` is the operation being refused, in the imperative the caller would print. */
export function protectedRefusal(reason, what, override) {
  const which =
    reason === 'demo'
      ? 'the live portfolio demonstration (app_settings.demo_database)'
      : 'marked protected (app_settings.protected_database)';
  return (
    `\nRefused: the database in DATABASE_URL is ${which}.\n\n` +
    `${what} would change it, and it is serving something real right now.\n` +
    'Point DATABASE_URL at a development database — a separate Neon branch is the cheapest one —\n' +
    `or, if changing this database is genuinely what you meant, run it again with ${override}.\n`
  );
}
