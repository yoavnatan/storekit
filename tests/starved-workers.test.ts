import { describe, expect, it } from 'vitest';
import { starvedFiles, starvedWorker } from '../scripts/lib/starved-workers.mjs';

/**
 * **The parse that decides whether `verify` re-runs two test files or four thousand** (2026-08-21).
 *
 * On the machine this project is built on, a full `npm run verify -- --all --no-cache` lost a vitest
 * worker on every one of the four runs measured that day — a different, random file each time, with
 * every assertion that ran having passed. The old remedy was to re-run the whole suite, which is
 * ~200 seconds on a run that already took 407. `verify` now re-runs only the files vitest names.
 *
 * That makes this parse load-bearing in a way a formatting helper is not: **a file it fails to
 * extract is a file that never ran, and the suite would report green having not tested it.** The
 * fallback is what protects that — no names parsed means re-run everything — so these tests pin
 * both the extraction AND the fallback, and the real vitest text is used verbatim rather than a
 * paraphrase, because the sentence is the contract and it belongs to a dependency.
 */

/** Copied byte for byte from a failing run on 2026-08-21. Do not tidy it. */
const REAL = `
⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-pool]: Failed to start forks worker for test files /repo/tests/user-carts-db.test.ts.
 ❯ ../../node_modules/vitest/dist/chunks/cli-api.js:3465:94
 ❯ Pool.schedule ../../node_modules/vitest/dist/chunks/cli-api.js:3465:5

Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond
 ❯ Timeout.<anonymous> ../../node_modules/vitest/dist/chunks/cli-api.js:3041:58

 Test Files  377 passed | 2 skipped (379)
      Tests  4784 passed | 2 skipped (4786)
     Errors  2 errors
`;

describe('a red run with nothing red in it', () => {
  it('is recognised as the machine, not the code', () => {
    expect(starvedWorker(REAL)).toBe(true);
  });

  it('is NOT recognised once any line names a failing test', () => {
    // The half that stops this from ever masking a real failure. A suite that lost a worker AND has
    // a failing assertion must be reported red, not retried.
    expect(starvedWorker(`${REAL}\n × tests/money.test.ts > refunds what was paid`)).toBe(false);
    expect(starvedWorker(`${REAL}\n FAIL tests/money.test.ts`)).toBe(false);
  });

  it('is not claimed for an ordinary failure with no pool error at all', () => {
    expect(starvedWorker(' Test Files  1 failed (379)\n')).toBe(false);
  });
});

describe('which files have to be re-run', () => {
  it('names the file vitest said never started', () => {
    expect(starvedFiles(REAL)).toEqual(['/repo/tests/user-carts-db.test.ts']);
  });

  it('reads ANSI-coloured output, which is what a real run produces', () => {
    const esc = String.fromCharCode(27);
    const coloured = REAL.replace('/repo/tests/user-carts-db.test.ts', `${esc}[31m/repo/tests/user-carts-db.test.ts${esc}[39m`);
    expect(starvedFiles(coloured)).toEqual(['/repo/tests/user-carts-db.test.ts']);
  });

  it('collects every starved worker in the run, without repeating one', () => {
    const two = `${REAL}\nError: [vitest-pool]: Failed to start forks worker for test files /repo/tests/b.test.ts.\n${REAL}`;
    expect(starvedFiles(two).sort()).toEqual(['/repo/tests/b.test.ts', '/repo/tests/user-carts-db.test.ts']);
  });

  it('handles the several-files-per-worker form vitest uses when it batches', () => {
    const many = 'Error: [vitest-pool]: Failed to start forks worker for test files /repo/tests/a.test.ts, /repo/tests/b.test.ts.\n';
    expect(starvedFiles(many)).toEqual(['/repo/tests/a.test.ts', '/repo/tests/b.test.ts']);
  });

  it('drops a name that is not a file on disk, so a re-run cannot be handed a phantom', () => {
    expect(starvedFiles(REAL, (f) => f !== '/repo/tests/user-carts-db.test.ts')).toEqual([]);
  });

  it('returns nothing when the sentence is not there — which means "re-run everything"', () => {
    // The fallback IS the safety property. If vitest ever rewords this line, the caller must go back
    // to the full re-run rather than re-run a shorter list it invented.
    expect(starvedFiles('Timeout waiting for worker to respond\n')).toEqual([]);
    expect(starvedFiles('[vitest-pool]: Failed to start forks worker for test files\n')).toEqual([]);
  });
});
