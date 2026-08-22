/**
 * Gives every test file its own Postgres, without any test having to ask for one.
 *
 * Runs before each test file (`setupFiles` in `vitest.config.ts`). It installs a database into
 * `src/lib/db.ts` that is LAZY: nothing is loaded until a module actually issues a query. That is
 * what keeps this free for the great majority of the suite — pure-logic tests, guard tests that
 * scan the tree — while a test that exercises a replaced module simply finds a working database
 * with the repo's data in it, no import and no setup call of its own.
 *
 * A test that needs to control the data can still call `setDatabase()` itself; the last one
 * installed wins, and this file restores nothing until the run ends.
 */

import { afterAll } from 'vitest';
import { setDatabase, type Database, type Queryable } from '../../src/lib/db.js';

let opened: { close(): Promise<void> } | undefined;
let opening: Promise<Database> | undefined;

/**
 * Load on first use, once — concurrent first queries must share one instance, not race to build.
 *
 * The `import()` is dynamic rather than a top-level import for the same reason the instance is
 * lazy: this file runs before all 122 test files, and pulling the PGlite WASM module into every one
 * of them cost ~200ms each for a database the great majority never touch.
 */
function ready(): Promise<Database> {
  opening ??= import('./test-db.js').then(async ({ asDatabase, loadImage }) => {
    const db = await loadImage();
    opened = db;
    return asDatabase(db);
  });
  return opening;
}

const lazy: Database = {
  query: async <Row>(text: string, params?: readonly unknown[]) => (await ready()).query<Row>(text, params),
  transaction: async <T>(run: (tx: Queryable) => Promise<T>) => (await ready()).transaction(run),
  close: async () => { await opened?.close(); },
};

setDatabase(lazy);

afterAll(async () => {
  await opened?.close();
});
