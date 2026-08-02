/**
 * `isDayISO` — one answer to "is this a real calendar day", and a grep guard that keeps it the only one.
 *
 * **Why this exists.** `/^\d{4}-\d{2}-\d{2}$/` was hand-rolled in eight places, and it is not the
 * rule it looks like: it accepts `9999-99-99`, `0000-00-00` and `2026-02-30`. That was survivable
 * while a date range was walked in JS — an `Invalid Date` made the cursor loop run zero times and
 * the report came back empty. It stopped being survivable when reports started reading a `date`
 * column (DB_MIGRATION_PLAN.md §8): Postgres raises `date/time field value out of range` on a
 * literal it cannot parse, so the same query string turned three reporting endpoints into 500s.
 *
 * The span guard that sits beside those regexes does not catch it either, and that is the part
 * worth remembering: `spanDays` is `NaN` for an unparseable date, and BOTH `NaN < 0` and
 * `NaN > MAX_DAYS` are false, so an impossible date sails through a bound written to stop exactly
 * this kind of input.
 *
 * Same family as `safe-redirect.test.ts` and `email-address.test.ts`: the rule lives in one module
 * and a test fails the build if a route grows its own copy.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isDayISO } from '../src/lib/business-day.js';

describe('isDayISO', () => {
  it('accepts real days, including leap day and both ends of a year', () => {
    for (const day of ['2026-07-01', '2026-01-01', '2026-12-31', '2024-02-29', '1999-06-15']) {
      expect(isDayISO(day), day).toBe(true);
    }
  });

  it('rejects the values the shape-only regex let through', () => {
    // Every one of these passes /^\d{4}-\d{2}-\d{2}$/ and raises on a Postgres `date` cast.
    for (const day of ['9999-99-99', '0000-00-00', '2026-13-01', '2026-00-10', '2026-02-30', '2026-04-31', '2025-02-29']) {
      expect(isDayISO(day), day).toBe(false);
    }
  });

  it('rejects anything that is not a bare ten-character day', () => {
    for (const day of ['', '2026-7-1', '2026-07-01T00:00:00Z', '2026-07-01 ', 'today', '20260701', '2026-07-01-01']) {
      expect(isDayISO(day), day).toBe(false);
    }
  });

  it('rejects a two-digit year rather than reading it as the 1900s', () => {
    // `new Date(Date.UTC(26, …))` is 1926 in JS. A report has no business reaching either.
    expect(isDayISO('0026-07-01')).toBe(false);
  });
});

describe('nobody re-implements it', () => {
  /** Every .ts/.astro file under src/, so a new route cannot quietly grow its own copy. */
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|astro)$/.test(entry.name) ? [full] : [];
    });
  }

  it('is the only day-shape check in src/', () => {
    // The literal, however it is written: as a regex, in a `.test()`, or assigned to a constant.
    const DAY_SHAPE = /\\d\{4\}-\\d\{2\}-\\d\{2\}/;
    const offenders = sourceFiles(path.join(process.cwd(), 'src'))
      .filter((file) => !file.endsWith(path.join('lib', 'business-day.ts')))
      .filter((file) => DAY_SHAPE.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(process.cwd(), file))
      .sort();

    expect(offenders, 'use isDayISO from lib/business-day.ts — a day-shaped string is not a day').toEqual([
      // Seller-entered sale window, stored in `jsonb` and only ever string-compared against a
      // stored day. It never reaches a `date` cast, so an impossible value here is an inert
      // window that matches nothing rather than a raised query — but it is listed, not ignored,
      // because that stops being true the day someone filters sales in SQL.
      'src/lib/discount-input.ts',
      // Reads a day back OUT of an ISO timestamp the application itself wrote — a capture, not a
      // validation of anything a request supplied.
      'src/lib/sitemap.ts',
      // The browser half of the money-journal toolbar: it narrows a value on its way INTO a URL,
      // and the server re-decides with isDayISO when it comes back (admin-moneylog-filter.ts).
      'src/scripts/admin/moneylog.ts',
    ]);
  });
});
