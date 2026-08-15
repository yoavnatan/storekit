/**
 * What the LAZY PANELS broke, and the shape of it, so it stops happening.
 *
 * On 2026-08-11 the seller dashboard stopped server-rendering all ten panels and started fetching
 * each on the click that opens it. That was the right change — it was ~865KB of HTML for one tab's
 * worth of answer — but it silently invalidated an assumption every client module had been written
 * under: **the whole page is in the document.** Four separate bugs came out of it in the days that
 * followed, none of them announced by an error, and all four reported by the owner rather than
 * caught by anything here:
 *
 *   1. the category tree was embedded inside the SETTINGS panel, so a product's edit form showed
 *      "ללא קטגוריה" for a product that had one, and every client-rebuilt row lost its chip
 *      (fixed by moving the island to the page shell — `dashboard-shared-data.test.ts`);
 *   2. the category PICKERS were bound by a sweep that runs with the products chunk, so the sale's
 *      scope menu was a dead button unless Products had been opened first (fixed panel-side);
 *   3. the picker read the store id off an element in Settings, so creating a category from a
 *      product, a sale or a boost posted an empty id;
 *   4. the overview's three attention tiles were bound from the ORDERS module, so on the landing
 *      page of a fresh load all three were dead.
 *
 * This file holds the one that is a RULE rather than a placement, and it is the nastiest of the
 * four because it fails in the direction that hides itself.
 *
 * ## Absent must not read as "busy"
 *
 * `tab-sync.ts#isBusy` asks whether the seller is mid-task before it live-refreshes a panel under
 * them. Two of its questions were `!document.getElementById(x)?.hidden` — and on a missing element
 * that is `!undefined`, i.e. TRUE. Both elements live in the products panel. So for every seller
 * who had not opened Products, "is anything open?" answered yes forever, and cross-tab live refresh
 * was declined for the rest of the session: the panel went stale and raised a notice instead of
 * quietly updating, which is exactly the behaviour that feature exists to avoid.
 *
 * The test reads the shipped source rather than running it, because the function is module-private
 * and the thing that has to hold is a spelling: an optional lookup compared against a definite
 * value, never negated.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/scripts/dashboard/tab-sync.ts'), 'utf8');

describe('a panel that has not loaded is not "busy"', () => {
  it('never negates an optional element lookup', () => {
    // `!document.getElementById('x')?.hidden` — true when the element is missing, which is the bug.
    const offenders = SRC.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => /!\s*document\.(getElementById|querySelector)\([^)]*\)\?\./.test(l.line));
    expect(offenders.map((o) => `${o.n}: ${o.line}`)).toEqual([]);
  });

  it('still asks the two questions it was asking', () => {
    // Guards the guard: deleting the checks would pass the rule above for the wrong reason.
    expect(SRC).toContain("getElementById('add-product-form')?.hidden === false");
    expect(SRC).toContain("getElementById('bulk-upload-panel')?.hidden === false");
  });
});
