/**
 * **A timestamp that has been through JavaScript is not the timestamp Postgres stored.**
 *
 * `timestamptz` keeps MICROseconds. A JS `Date` keeps milliseconds, and node-postgres parses every
 * timestamp column into one (`lib/db.ts` registers no parser for OID 1184). So a value read out of
 * a row and sent back as a predicate has quietly lost its last three digits, and the direction of
 * the loss is what makes it dangerous: `…:46.001380+00` comes back as `…:46.001Z`, which is EARLIER
 * than the row it came from. Against `>=` that is harmless — the row is simply re-read, and callers
 * here de-duplicate by id. Against `=` it matches **nothing at all**, and a query that matches
 * nothing does not fail; it returns an empty list that every caller is already built to handle.
 *
 * That is exactly how it shipped. `getSellerOrdersSince`'s seed asked for "the ids at the newest
 * moment" with `created_at = $2::timestamptz`, got none, and told the browser it had seen nothing —
 * so the first poll fifteen seconds later announced the store's newest EXISTING order as new. The
 * seller got a toast and a phantom order card on every single refresh, with nothing in the
 * notifications bell behind it, because nothing had been written: the toast was the whole event
 * (owner, 2026-08-11). It reproduced on 6 of 38 seeded stores — precisely the ones whose newest
 * order came from a real checkout, where `now()` supplies microseconds, rather than from the demo
 * seeder, which writes whole milliseconds and therefore has nothing to truncate.
 *
 * **The existing test could not have caught it, and that is the part worth keeping in view.** The
 * invariant was already asserted in `seller-orders-page-parity.test.ts` and was already green: its
 * fixture writes whole-millisecond timestamps, so the round trip was lossless and the bug was
 * unreachable. Test data that is tidier than production data is a test that agrees with you.
 *
 * So this scans the tree rather than the two modules that were fixed. The rule is narrow on
 * purpose — an equality FILTER on a timestamp column against a bound parameter — because that is
 * the shape whose failure is silent. Assignments are untouched: `SET ends_at = $9` is how a value
 * gets written, and writing a millisecond-precision instant is fine, since nothing later asks a
 * row to equal itself.
 *
 * The two ways to comply, both already in the tree and both correct for where they sit:
 *   · **Widen the window** — `>=` plus de-duplication by id (`lib/orders.ts#getSellerOrdersSince`).
 *     Cheapest where the caller tracks ids anyway.
 *   · **Keep the precision** — read the column as text with `to_char(… 'US')` so the microseconds
 *     survive the trip out and back (`lib/notifications.ts#normalizeCursor`). Necessary where the
 *     cursor is a strict `>`, because there a lost digit makes a row permanently newer than its own
 *     cursor and the feed stops advancing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(ts|astro)$/.test(e.name) ? [full] : [];
  });
}

/** SQL in this repo always lives in a backtick literal — `query`/`rows`/`firstRow` take one. */
const TEMPLATE = /`[^`]*`/g;

/**
 * `<something>_at = $N`. Anchored on the `_at` naming convention every timestamp column here
 * follows (`created_at`, `paused_at`, `starts_at`, `last_seen_at`) rather than on a list of column
 * names, so a column added tomorrow is covered without anyone remembering this file.
 *
 * **A cast on the COLUMN side deliberately falls outside this.** `created_at::date = $1` asks which
 * DAY a row falls on, which is a different question with a different right answer — the value has
 * been narrowed to something a millisecond round trip cannot damage, and flagging it would teach
 * people to skip the guard. Only the bare instant compared against a bound parameter is the bug.
 */
const EQ_FILTER = /\b\w*_at\s*=\s*\$\d+/gi;

describe('a timestamp column is never compared with = against a bound parameter', () => {
  const files = walk(SRC).map((f) => ({
    rel: path.relative(SRC, f).split(path.sep).join('/'),
    text: fs.readFileSync(f, 'utf8'),
  }));

  it('finds no equality filter on a timestamp anywhere in src/', () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const literal of file.text.match(TEMPLATE) ?? []) {
        // Only a WHERE makes it a filter. In `UPDATE … SET ends_at = $9 WHERE id = $1` the
        // assignment sits BEFORE the first WHERE, which is what separates the two cases without
        // needing to parse SQL.
        const whereAt = literal.search(/\bWHERE\b/i);
        if (whereAt < 0) continue;
        for (const m of literal.matchAll(EQ_FILTER)) {
          if (m.index !== undefined && m.index > whereAt) {
            offenders.push(`${file.rel}: ${m[0].trim()}`);
          }
        }
      }
    }

    expect(
      offenders,
      'A timestamp read out of Postgres loses its microseconds in JavaScript, so this matches ' +
        'nothing and fails silently. Widen the window to >= and de-duplicate, or read the column ' +
        'as text with to_char(… \'US\'). See the header of this file.',
    ).toEqual([]);
  });

  it('recognises the shape it is meant to catch', () => {
    // The guard is worth only as much as its regex, and a scan that has quietly stopped matching
    // reports a clean tree — the same failure mode as the bug it exists for.
    const broken = 'SELECT id FROM orders o WHERE o.store = $1 AND o.created_at = $2::timestamptz';
    const fixed = 'SELECT id FROM orders o WHERE o.store = $1 AND o.created_at >= $2::timestamptz';
    const assignment = 'UPDATE coupons SET starts_at = $8, ends_at = $9 WHERE id = $1';
    const day = 'SELECT id FROM orders o WHERE o.created_at::date = $1';

    const filters = (sql: string): string[] => {
      const whereAt = sql.search(/\bWHERE\b/i);
      return [...sql.matchAll(EQ_FILTER)]
        .filter((m) => m.index !== undefined && m.index > whereAt)
        .map((m) => m[0]);
    };

    expect(filters(broken)).toHaveLength(1);
    expect(filters(fixed)).toHaveLength(0);
    expect(filters(assignment), 'a SET assignment is not a filter').toHaveLength(0);
    expect(filters(day), 'a cast to date is a different question, not this bug').toHaveLength(0);
  });
});
