import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A field that is wrong says so ON THE FIELD, never in a toast.
 *
 * **The rule, and where it came from (owner, 2026-08-20):** *"אני רואה שוולידציה מקבלת טוסט, זה לא
 * טוב, היא צריכה לקבל את הקו האדום ו'דרוש שדה זה' למטה. אמרת כל הולידציות קיבלו את הסגנון הזה, למה
 * יש שם עוד טוסט?"* — and he was right that it had been said before. `lib/field-validity.ts` is that
 * style and every form on the platform uses it; two screens predated it and kept their own toast,
 * including the one that decides a dispute.
 *
 * The distinction is not cosmetic. A toast is for something that happened SOMEWHERE ELSE — a request
 * that failed, a job that finished — and it disappears on a timer. A validation message is about a
 * specific box that is still on screen and still wrong: it has to sit next to that box, stay until
 * the box is fixed, and be reachable by a screen reader through `aria-describedby`. A toast does
 * none of those, and on a form with two fields it does not even say which one.
 *
 * ── What this refuses, and what it deliberately allows ──
 * It looks for a toast on a path that has just READ a field's value and found it wanting — the shape
 * `showToast(...)` sitting inside a branch that tested an input. A toast reporting the SERVER's
 * answer (`if (said?.error) showToast(...)`) is not validation and is left alone: nothing on screen
 * is marked wrong, and the thing that failed really did happen elsewhere.
 */

function walk(dir: string): string[] {
  const abs = path.join(process.cwd(), dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel);
    return entry.isFile() && /\.(ts|astro)$/.test(entry.name) ? [rel] : [];
  });
}

const FILES = ['src/scripts', 'src/components', 'src/pages'].flatMap(walk);
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');

/** Words that only ever appear in a message about a box the person has to go back and fix. */
const VALIDATION_WORDS = /חסר |לא תקין|צריך לכתוב|צריך לבחור|שדה חובה|לא יכול להיות ריק/;

describe('validation belongs on the field', () => {
  it('scans a real set of files', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => read(f).includes('showFieldError'))).toBe(true);
  });

  it('no toast carries a message that belongs under an input', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = read(file);
      for (const m of src.matchAll(/showToast\(([^;]*?)\)\s*;/gs)) {
        const args = m[1] ?? '';
        // A server-reported failure is not validation: it is the answer to a request, and nothing
        // on screen is marked wrong. Those read the message off the response.
        if (/said\?|data\?|res\b|error\b/.test(args)) continue;
        if (VALIDATION_WORDS.test(args)) offenders.push(`${file}: ${args.replace(/\s+/g, ' ').slice(0, 70)}`);
      }
    }
    expect(
      offenders,
      'Use showFieldError()/clearFieldError() from lib/field-validity.ts — the red rule and the\n'
      + 'line under the box. A toast does not say WHICH field, does not survive being read, and is\n'
      + 'gone before a slow reader gets to it.',
    ).toEqual([]);
  });
});
