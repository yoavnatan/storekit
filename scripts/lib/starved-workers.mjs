/**
 * **Reading a vitest run that died on the machine rather than on a test.**
 *
 * Split out of `verify.mjs` on 2026-08-21 so it can be tested. What it decides is when a red run may
 * be re-run automatically and, since the same day, WHAT has to be re-run — and the second half is
 * the one that has to be right. `verify` now re-runs only the test files vitest says never started,
 * because re-running all 4784 tests to recover two of them was measured at ~200s a time on a run
 * that already took 407s, and it happened on every full run that day.
 *
 * Both functions read the run's raw output, which is the only place the information exists: vitest
 * reports this as an unhandled error, not as a test result, so there is no machine-readable channel
 * to ask instead.
 */

/** ESC written via fromCharCode: a raw control character in a regex is a lint error. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Vitest colours its output; every pattern here is matched against the plain text. */
export const strip = (s) => String(s).replace(ANSI, '');

/**
 * Did the suite die on a worker that never booted, rather than on a test?
 *
 * Both halves are required. `Failed to start forks worker` / `Timeout waiting for worker to respond`
 * is the infrastructure signature; the absence of any FAIL line is what proves nothing the code does
 * is implicated. `verify`'s `salient()` leans on the same absence, for the same reason.
 */
export function starvedWorker(out) {
  const text = strip(out);
  return /Failed to start \S+ worker|Timeout waiting for worker to respond|vitest-pool/.test(text)
    && !/✗|×|FAIL/.test(text);
}

/**
 * The test FILES a starved run never got to run.
 *
 * `[vitest-pool]: Failed to start forks worker for test files <path>[, <path>].` is the only line
 * that carries them, and it carries them as absolute paths — which is what makes re-running just
 * those possible. One line per starved worker, so a run that lost two workers produces two.
 *
 * **Returns [] rather than guessing when the shape is not there**, and the caller must treat that as
 * "re-run everything". A file missed here is a file that never ran at all, and reporting it green
 * would be the one outcome worse than being slow. The trailing `.` is part of vitest's sentence and
 * is required by the pattern for the same reason: it proves the path was not truncated mid-line.
 *
 * @param {string} out — the run's raw output, ANSI and all.
 * @param {(file: string) => boolean} [exists] — `existsSync` in production; a stub in the tests.
 * @returns {string[]}
 */
export function starvedFiles(out, exists = () => true) {
  const files = new Set();
  const line = /Failed to start \S+ worker for test files ([^\n]+?)\.(?:\s|$)/gu;
  for (const match of strip(out).matchAll(line)) {
    for (const raw of match[1].split(',')) {
      const file = raw.trim();
      if (file && exists(file)) files.add(file);
    }
  }
  return [...files];
}
