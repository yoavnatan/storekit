import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══ A TEST MUST BUILD ITS DAYS ON THE SAME CALENDAR THE CODE COUNTS ON ═══
 *
 * ── The incident, 2026-08-19 ──
 *
 * `returns-scenarios.test.ts` failed for three hours every night, on main, with nobody's change
 * behind it. Its helper built a day with `toISOString().slice(0, 10)` — UTC — while every deadline it
 * was compared against comes from `businessDayISO`, i.e. the day in `Asia/Jerusalem`. The two agree
 * for most of the day and disagree from local midnight until 03:00, when Jerusalem has already turned
 * over and UTC has not. In that window the test's "today" is one day behind every deadline, so the one
 * assertion sitting on an exact boundary — the warning fired the day BEFORE the handover window closes
 * — missed by one and reported `expected 0 to be greater than 0`.
 *
 * **The cost is not the three hours; it is who pays them.** A red test on main looks exactly like
 * whatever diff happens to be open at the time, so it is charged to the next session that runs the
 * suite, which reads its own change looking for a bug that is not there. It was charged to one before
 * this guard existed.
 *
 * ── The rule, and why it is this narrow ──
 *
 * `toISOString().slice(0, 10)` is the one spelling that silently means UTC. `businessDayISO` /
 * `businessTodayISO` (Asia/Jerusalem — what every deadline, payout and report in this repo counts on)
 * and `calendarDayISO` (a synthetic date with no timezone meaning) both say which calendar they mean
 * in their own name, which is the whole difference.
 *
 * Untouched on purpose: `new Date(`${iso}T00:00:00.000Z`)` + `setUTCDate` — stepping a synthetic
 * midnight-Z date is `calendarDayISO`'s own mechanism and has no timezone meaning to get wrong.
 * The production side already learned this (see the headers of `seller-performance.ts`,
 * `seller-reports.ts` and `scripts/dashboard/coupons.ts`); this is the layer for the test side,
 * which had not.
 */
const TESTS = join(process.cwd(), 'tests');

/** Source with comments stripped — the spelling named in a header is documentation, not a use. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('a test builds its days on the business calendar, not in UTC', () => {
  it('no test derives a calendar day from toISOString()', () => {
    const offenders: string[] = [];

    for (const name of readdirSync(TESTS).filter((f) => f.endsWith('.test.ts'))) {
      const src = code(join(TESTS, name));
      // Two simple patterns rather than one alternation: `.slice(0, 10)` / `.substring(0, 10)`, and
      // the `.split('T')[0]` spelling of the same thing.
      const sliced = [...src.matchAll(/toISOString\(\)\s*\.\s*(?:slice|substring)\(\s*0\s*,\s*10\s*\)/g)];
      const split = [...src.matchAll(/toISOString\(\)\s*\.\s*split\(\s*'T'\s*\)\s*\[0\]/g)];
      const hits = sliced.length + split.length;
      if (hits > 0) offenders.push(`${name} (${hits})`);
    }

    expect(
      offenders,
      'These derive a calendar day in UTC, while every deadline in this repo is counted in\n'
      + `  Asia/Jerusalem (${'businessDayISO'}). They agree for most of the day and disagree from local\n`
      + '  midnight until 03:00 — so the test passes when you write it and fails at night, on main,\n'
      + '  looking like somebody else\'s change. Use businessTodayISO() / businessDayISO() for a real\n'
      + '  day, or calendarDayISO() for a synthetic one.\n'
      + `  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
