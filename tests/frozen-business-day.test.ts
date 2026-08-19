import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No test file freezes "today" at import and then asserts against it.
 *
 * **The failure this exists for, 2026-08-20 at 00:0x local.** Four test files computed the business
 * day once at module load and used it as the window every assertion read. A suite that starts
 * before midnight in Asia/Jerusalem and reaches those tests after it writes its rows into one
 * business day and reads the other — so `expected 0 to be 2`, three times, with nothing in the
 * message pointing at a clock, and everything passing on a re-run five minutes later.
 *
 * It turned CI red on a push whose diff could not possibly have caused it, which is the expensive
 * part: the session spent its time reading an unrelated change. **A test that fails once a day, in
 * the hour the people here actually work, is worse than one that fails always** — it teaches
 * everybody to re-run instead of read, and then a real failure gets re-run too.
 *
 * The rule is narrow on purpose: a day captured at module scope is the bug, and the same call
 * inside a test or a helper is fine — by then the writes it is about to check have happened.
 */

const TESTS = join(process.cwd(), 'tests');

/** Module scope = column 0. A declaration indented by even one space is inside something — a
 *  `describe`, an `it`, a helper — and is therefore evaluated when that thing runs. */
const FROZEN_AT_MODULE_SCOPE = /^const\s+\w+\s*=\s*business(Day|Today)ISO\s*\(/m;

describe('a test never freezes the business day at import', () => {
  it('has no module-scope const holding today', () => {
    const offenders = readdirSync(TESTS)
      .filter((f) => f.endsWith('.test.ts'))
      // This file quotes the pattern it forbids.
      .filter((f) => f !== 'frozen-business-day.test.ts')
      .filter((f) => FROZEN_AT_MODULE_SCOPE.test(readFileSync(join(TESTS, f), 'utf8')));

    expect(
      offenders,
      'This captures the business day when the FILE loads, and a suite that crosses midnight in\n'
      + 'Asia/Jerusalem then writes into one day and asserts against the other — every count comes\n'
      + 'back 0, once a day, in the evening. Make it a function (`const businessToday = () =>`) and\n'
      + 'call it after the writes, the way store-pageviews-db.test.ts does.',
    ).toEqual([]);
  });
});
