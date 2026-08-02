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
  },
});
