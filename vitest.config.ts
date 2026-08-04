import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Stage 2 of DB_MIGRATION_PLAN.md moves lib/* from JSON files to queries, so the suite needs a
    // Postgres. globalSetup builds one image (schema + the repo's own data) per run and caches it
    // on content; the setup file then hands each test file its own copy, loaded only if something
    // actually queries. See tests/helpers/test-db.ts for why it is real Postgres and not a mock.
    globalSetup: ['tests/helpers/db-global-setup.ts'],
    setupFiles: ['tests/helpers/db-setup.ts'],
    // The database loads on the first query a test file makes, so that one-time cost (~1.3s alone,
    // measured over 5s when eight workers and `astro check` share the CPU) lands inside whichever
    // test happens to be first — and blew the 5s default there, in that file only, intermittently.
    // Raised rather than warmed in a per-file hook: every test file would have to remember the
    // hook, and the one that forgot would fail the same way. Nothing here waits on a network or a
    // human, so a test that runs long enough to hit this is hung, and 30s still says so.
    testTimeout: 30_000,
    // The same argument, for the hook the note above describes — and it was left at the 10s default,
    // which is why the fix was only half a fix. `beforeAll` in db-setup.ts is where a file's DB copy
    // is actually loaded, so under load that hook is the long pole, not the test. Symptom: `npm run
    // verify` goes red with 3-7 DB test FILES failing at 10-13s each, a DIFFERENT random subset every
    // run, every one of them passing in ~2s when run on its own. Reproduced 2026-08-04 with a second
    // session's dev server, migrations and `astro check` competing for the same 12 cores; the suite
    // is fully green serially (131s) and at --maxWorkers=4 (39s), which is what points at scheduling
    // rather than at any test. Throttling workers would have hidden it and cost every future run.
    hookTimeout: 30_000,
  },
});
