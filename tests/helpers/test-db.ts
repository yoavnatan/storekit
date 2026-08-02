/**
 * Postgres for the test suite — in-process, no server, no install.
 *
 * **Why the suite needs a database at all now (DB_MIGRATION_PLAN.md §8 stage 2).** Stage 2 replaces
 * `lib/*` module by module, file read → query. The first module that flips takes every test that
 * touches it with it, and §9.1 makes the existing tests the gate the whole stage is measured
 * against: "if a module was replaced correctly they pass unchanged". A gate that needs a running
 * Postgres before it can say anything is a gate that gets skipped on a branch that stays broken in
 * the middle for weeks.
 *
 * **Why PGlite and not a mock.** PGlite is Postgres itself compiled to WASM — the same parser,
 * planner and constraint machinery. A `UNIQUE` that would be violated in production is violated
 * here; `citext` and `NOT NULL DEFAULT false` behave as they do there. That is what makes green
 * mean something. Mocking each replaced module would test the mocks instead, and would have let
 * both §7.1 (global slug uniqueness) and §7.12 (NULL flags) through — each fails on the first row
 * of the real data and neither is visible by reading.
 *
 * **Why a dumped image rather than migrate-and-import per file.** Building the schema and importing
 * costs a couple of seconds; paying that in each of ~20 test files would add a minute to every run
 * and the suite would stop being run. It is built ONCE per `npm test` (`db-global-setup.ts`) and
 * each test file loads that image, which is roughly a disk read. Every file still gets its OWN
 * instance, so a test that writes cannot leak into another file — better isolation than the shared
 * `data/*.json` this replaces.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { importAll } from '../../scripts/lib/db-import.mjs';
import type { Database, Queryable, QueryOutcome } from '../../src/lib/db.js';

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, 'migrations');
/** The committed dataset every test runs against — see `buildImage` for why it is never `data/`. */
export const FIXTURE = path.join(ROOT, 'tests/fixtures/db-data');

/** Where the built image lives. `node_modules` is already gitignored, so it needs no new rule. */
export const IMAGE_PATH = path.join(ROOT, 'node_modules/.cache/storekit/test-db.tar.gz');

/**
 * `bigint` (`int8`) arrives as a string on the wire because it does not fit a JS number — the same
 * reason `db.ts` registers a parser for oid 20 on the `pg` side. Registering the matching one here
 * is what keeps a money column and a `COUNT(*)` reading as numbers under both drivers; without it a
 * module would pass its tests comparing `'4200'` and fail in production comparing `4200`.
 */
const PARSERS = { 20: (value: string) => Number(value) };

/** Every migration, in order, with the one line PGlite cannot run removed. */
export function migrationSql(): string[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) =>
      fs
        .readFileSync(path.join(MIGRATIONS, name), 'utf8')
        // pgvector is not bundled with PGlite. It is created in the migration deliberately (a
        // provider that cannot run that line is the wrong provider — DB_MIGRATION_PLAN.md §2.1),
        // and nothing in the schema depends on it yet, so this is the ONLY line tests skip.
        .replace(/^CREATE EXTENSION IF NOT EXISTS vector;$/m, ''),
    );
}

/** A fresh, empty Postgres with the schema applied and nothing in it. */
export async function createSchemaOnly(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { citext, pg_trgm }, parsers: PARSERS });
  for (const sql of migrationSql()) await db.exec(sql);
  return db;
}

/**
 * Build the image: the schema plus `tests/fixtures/db-data`, dumped to a loadable tarball.
 *
 * **The fixture, never `data/` — decided 2026-08-02.** The tempting alternative is "the real data
 * locally, the fixture in CI", because the real data carries traps nobody would think to write down.
 * It fails on the property that matters more: the suite would then be judging different rows on the
 * developer's machine than on the machine that gates every push, so a test could be green here and
 * red there — or worse, green in both while asserting different things. `data/` is also gitignored
 * (it holds real buyer names and addresses) and mutates under a running dev server, so it is not
 * reproducible even against itself between two runs an hour apart.
 *
 * The fixture keeps the traps deliberately rather than by luck — §7.1's cross-store slug collision,
 * §7.12's absent flags, §7.3's two bucket shapes, §7.11's case-only duplicate email. It is small
 * (single-digit rows per table), which is a consequence of the choice and not a defect: a test that
 * needs a particular record inserts it, and one that needs volume builds it. What the real data
 * still gets is `db-import.test.ts`, which imports it directly when present.
 */
export async function buildImage(): Promise<void> {
  const db = await createSchemaOnly();
  try {
    await importAll(db, { dataDir: FIXTURE });
    const blob = await db.dumpDataDir('gzip');
    fs.mkdirSync(path.dirname(IMAGE_PATH), { recursive: true });
    fs.writeFileSync(IMAGE_PATH, Buffer.from(await blob.arrayBuffer()));
  } finally {
    await db.close();
  }
}

/** A private Postgres loaded from the image — the repo's data, already imported. */
export async function loadImage(): Promise<PGlite> {
  const bytes = fs.readFileSync(IMAGE_PATH);
  return PGlite.create({
    loadDataDir: new Blob([bytes]),
    extensions: { citext, pg_trgm },
    parsers: PARSERS,
  });
}

/**
 * Wrap a PGlite instance as the `Database` that `src/lib/db.ts` hands to every module.
 *
 * **The row count is where the two drivers disagree, and it had to be measured (2026-08-02).**
 * `pg` reports one number, `rowCount`, meaning "rows returned OR rows affected". PGlite reports
 * `affectedRows`, and for a `SELECT` that value is **0, not absent** — so a `??` fallback does not
 * rescue it, and a module asking "did that find anything?" by the count would read 0 here and the
 * true number in production. Measured for each statement kind:
 *
 *     SELECT 3 rows     affectedRows 0   rows 3      (pg: 3)
 *     UPDATE 2 rows     affectedRows 2   rows 0      (pg: 2)
 *     INSERT RETURNING  affectedRows 1   rows 1      (pg: 1)
 *
 * `Math.max` is the rule that reproduces `pg` on all three: a statement returns rows or affects
 * them, never both from different sets. This matters most for the atomic stock decrement (§7.5),
 * whose entire verdict — sold, or not enough stock — is this number.
 */
export function asDatabase(db: PGlite): Database {
  const runner = (target: { query: PGlite['query'] }): Queryable => ({
    async query<Row>(text: string, params: readonly unknown[] = []): Promise<QueryOutcome<Row>> {
      const result = await target.query<Row>(text, params as unknown[]);
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) };
    },
  });
  return {
    query: runner(db).query,
    transaction: (run) => db.transaction((tx) => run(runner(tx as { query: PGlite['query'] }))),
    close: () => db.close(),
  };
}
