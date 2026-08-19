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
    // ── The worker pool is CAPPED, and the note above is why it took three tries to get here ──
    //
    // That note ends "throttling workers would have hidden it and cost every future run", and on
    // 2026-08-04 that was the right call: the symptom was a TEST timing out, throttling would have
    // masked a possible real bug, and the honest fix was to find out whether the tests were slow.
    // They were not — `scripts/lib/test-lock.mjs` then serialised the suite across sessions and the
    // failures stopped.
    //
    // **The failure came back on 2026-08-19 wearing a different face, and neither earlier fix can
    // touch it:** `[vitest-pool]: Failed to start forks worker` / "Timeout waiting for worker to
    // respond" — twelve of them in one run, with every test that DID run passing. A worker that
    // never starts is not a slow test, so no `testTimeout` reaches it; and the lock cannot help
    // either, because the process competing for the cores is not another test run. It is the other
    // session's `astro check`, which `test-lock.mjs` deliberately leaves unlocked on the premise
    // that type-checking is "CPU-bound but short". **That premise expired** — this suite's own
    // `astro check` now measures 54–140s of full-CPU work, so two sessions reliably hand twelve
    // vitest workers a fraction of a core each at exactly the moment they are trying to boot.
    //
    // So the cap is not a way to hide a slow test any more; it is the only layer that bounds what
    // ONE run can demand, whatever else is on the machine — including the steps that are not, and
    // should not be, serialised. Four is the number that session measured itself: fully green in
    // 39s against 131s serial, i.e. the cap is FASTER than the uncapped run it replaces, because
    // twelve workers on twelve contended cores spend their time context-switching. It also leaves
    // most of the machine for whatever the other session is doing, which is the point.
    //
    // **It cannot weaken bug-finding, and that is worth stating rather than assuming** (owner,
    // 2026-08-19: *"שבשום פנים ואופן לא יפגע במציאת באגים"*). `maxForks` changes only how many test
    // FILES run at the same moment. Every file still runs, every assertion still runs, and both
    // timeouts stay where they are — nothing is skipped, sampled or shortened. What it removes is
    // contention, which was producing FALSE failures, and a suite that cries wolf is the thing that
    // actually costs bugs: a red run nobody trusts gets re-run instead of read.
    //
    // The one honest question is whether fewer parallel workers could hide a CONCURRENCY bug. It
    // cannot here, because this repo does not lean on worker parallelism to create races: the
    // places where concurrency is the subject drive it explicitly INSIDE a single test — 50
    // simultaneous buyers of one unit in the oversell proof (DB_MIGRATION_PLAN §7.5/§9.5), the
    // double-run passes in `jobs-scheduler.test.ts`, the retried payout in `payouts.test.ts`. Those
    // are unaffected by how many files sit beside them.
    // `maxWorkers`, not `poolOptions.forks.maxForks`: this is Vitest 4, where the per-pool shape
    // the older docs describe no longer type-checks (`astro check` refused it, which is the gate
    // doing its job). The top-level option is the one that survived the version, and it applies
    // whichever pool is in use rather than only to the one it happens to be named after.
    maxWorkers: 4,
  },
});
