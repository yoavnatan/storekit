/**
 * A widget that WRITES a form field programmatically must also LISTEN when the form replaces it.
 *
 * The two halves are one rule, and they were four separate omissions. `announceValueChange(field)`
 * is how a widget says "I just wrote this without firing an event" — which is only ever true of a
 * widget keeping its state IN a field and its picture in the DOM. Exactly those widgets break when
 * the traffic goes the other way: "discard changes" and a recovered draft both replace fields from
 * outside and dispatch `dash:fieldsrewritten`, and a widget that is not listening keeps showing
 * what the form no longer holds — with the next save writing the value the seller cannot see.
 *
 * Found by the owner on the header-logo card (2026-08-09, "כשאני לוחץ שחזר התמונה לא חוזרת"), and
 * the sweep for the class found three more: the sale-scope picker, the product multi-picker and the
 * product gallery. Every one had the same shape — correct in `store-image.ts`, where the rule was
 * learned, and missing in all four places it was learned again.
 *
 * The multi-picker's version is why this is a guard rather than four fixes. It reads the field into
 * a `Set` once at init, so a stale set did not merely LOOK wrong: the seller's next tick calls
 * `commit`, which writes that set back over the value the restore had just put there. Silent, and
 * it undoes the recovery it was meant to survive.
 *
 * Scanned rather than listed, so the widget written next month is covered the day it exists.
 *
 * **The rule has a READER half, and it cost a fifth instance to notice (2026-08-10).** Everything
 * above is about a widget that WRITES a field. `scripts/form-validity.ts` writes none — it paints
 * state FROM a field's value (the invalid line and its message) — and it broke the same way: the
 * seller emptied a required field, saved, saw the message, pressed "בטל שינויים", and the value
 * came back with the message still under it. Anything that DERIVES what is on screen from a
 * field's value owes the same listener, not only anything that sets one.
 * That half is held behaviourally rather than by this scan — `tests/form-validity-repaint.test.ts`
 * drives the real listeners — because 'reads a field' has no grep-able shape the way
 * `announceValueChange` does.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (rel.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/** The module that DEFINES the pair is not a consumer of it. */
const OWNERS = [join('src', 'scripts', 'dashboard', 'unsaved-guard.ts')];

const writers = (): string[] => walk('src')
  .filter((f) => readFileSync(join(ROOT, f), 'utf8').includes('announceValueChange('));

describe('every widget that writes a field also repaints from it', () => {
  it('has no announceValueChange without a dash:fieldsrewritten listener', () => {
    const offenders = writers()
      .filter((f) => !OWNERS.includes(f))
      .filter((f) => !readFileSync(join(ROOT, f), 'utf8').includes('dash:fieldsrewritten'));
    expect(
      offenders,
      'these write a form field by hand but never repaint when the form replaces it — add a '
      + '`dash:fieldsrewritten` listener that RE-READS the field (see store-image.ts). Re-rendering '
      + 'without re-reading is not enough: a widget caching the value in its own state writes the '
      + 'stale copy back on the next edit.',
    ).toEqual([]);
  });

  it('still finds the widgets it is meant to be watching', () => {
    // The tripwire under the guard: a scan that silently matches nothing passes forever. If
    // `announceValueChange` is renamed or the widgets move, this fails instead of the rule quietly
    // ceasing to apply to anything.
    expect(writers().length).toBeGreaterThanOrEqual(6);
  });
});
