import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Two mechanical rules that both cost real bugs on 2026-08-20, in one afternoon.
 *
 * ── 1. A confirmation dialog says `message`, and only `message` ──
 *
 * `ConfirmModal.astro` reads `detail.message` and falls back to a generic "this cannot be undone".
 * A caller that says `body:` therefore opens a dialog that looks perfectly correct and states
 * NOTHING about what is being confirmed — no error, no warning, and the failure is invisible unless
 * somebody opens that exact dialog and reads it.
 *
 * It had happened once, in `scripts/admin/returns.ts`: the admin deciding a dispute, which is the
 * single most money-critical confirmation on the platform. Its `body` had three carefully written
 * branches naming the exact amount about to be moved, and every one of them was dead. Found because
 * the owner asked whether the critical actions have a dialog at all.
 *
 * ── 2. An `.astro` comment may not be the first child of a `&& (` ──
 *
 * `{cond && ( {/* … *\/} <p/> )}` is two sibling expressions with no fragment around them. Astro's
 * compiler does not report it as an error at that line — the route simply answers 404 from then on,
 * with nothing anywhere naming the file. It cost three separate debugging rounds in one session.
 */

function walk(dir: string, exts: RegExp): string[] {
  const abs = path.join(process.cwd(), dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel, exts);
    return entry.isFile() && exts.test(entry.name) ? [rel] : [];
  });
}

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');

describe('every confirmation dialog states what it is about', () => {
  const FILES = ['src/scripts', 'src/components', 'src/pages']
    .flatMap((d) => walk(d, /\.(ts|astro)$/));

  it('scans a real set of files, so this cannot pass by finding nothing', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => read(f).includes("'confirm:open'"))).toBe(true);
  });

  it("no caller of confirm:open passes `body:` — ConfirmModal reads `message`", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = read(file);
      // Each dispatch, then the object literal that follows it. `body:` anywhere in the next ~30
      // lines of that call is the mistake; a `body:` on the `fetch` inside `onConfirm` is not, and
      // is why this looks at the detail object rather than at the whole file.
      for (const m of src.matchAll(/confirm:open'[^)]*?\{\s*detail:\s*\{/g)) {
        const from = (m.index ?? 0) + m[0].length;
        const detail = src.slice(from, from + 900);
        // Stop at `onConfirm`, which is where the caller's own request body legitimately begins.
        const head = detail.split('onConfirm')[0] ?? '';
        if (/\bbody\s*:/.test(head)) offenders.push(file);
      }
    }
    expect(
      [...new Set(offenders)],
      'ConfirmModal reads `detail.message`. A `body:` opens a dialog showing the generic default\n'
      + 'instead of the sentence that says what is about to happen — silently.',
    ).toEqual([]);
  });
});

/**
 * A dialog that CONFIRMS something positive does not wear the delete button's red.
 *
 * `ConfirmModal.astro` ships its OK in the danger skin, deliberately: nearly every confirmation on
 * this site guards a delete, a block or a cancellation, and that default is what makes red mean
 * "this one takes something away". A caller with a positive OK — approving a return, lifting a block
 * — must pass `tone: 'primary'`, or it spends the platform's one such signal on the opposite act
 * (owner, 2026-08-20: *"מודלים של אישורים לא צריך שיהיה בתוכם כפתור אדום, כי אם מאשרים משהו זה דבר
 * שהוא נתפס כחיובי"*).
 *
 * Matched on the OK LABEL, which is the only part of a dialog that always states the act in the
 * seller's own words — a title can be phrased either way ("לבטל את חסימת החנות?") and a message says
 * consequences. The list is literal phrases rather than a stem: `בטל חסימה` is restorative while
 * `בטל קידום` and `בטל הזמנה` take something away, and a rule keyed on `בטל` would get all three
 * wrong. Add a phrase here when a new positive confirmation is written; a label built from the
 * dictionary at runtime is out of reach of any file scan, and lands on review instead.
 */
describe('a positive confirmation is not red', () => {
  const FILES = ['src/scripts', 'src/components', 'src/pages']
    .flatMap((d) => walk(d, /\.(ts|astro)$/));

  /**
   * OK labels that say the button GIVES something back.
   *
   * The two refund labels joined the list on 2026-08-21, when the owner found them still red:
   * paying a return IS the ordinary end of one, and an admin deciding a dispute in the buyer's
   * favour is the ordinary outcome too. What stays red is the branch that closes a case AGAINST
   * somebody — refusing, escalating, and "סגור בלי החזר".
   */
  const POSITIVE = ['אשר את ההחזרה', 'בטל חסימה', 'החזר את הכסף', 'החזר לקונה'];

  it('finds the positive labels it is written about — a rename must not silence it', () => {
    const all = FILES.map(read).join('\n');
    for (const label of POSITIVE) expect(all, `no caller says "${label}" any more`).toContain(label);
  });

  it("every positive okLabel sits beside tone: 'primary'", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = read(file);
      for (const label of POSITIVE) {
        // Each occurrence AS AN okLabel, then the object literal around it. 400 characters each way
        // covers the biggest of these specs (title + message + workingLabel) and stops well short of
        // the next sibling's tone.
        // An `okLabel:` LINE containing the literal — not the literal on its own, and not
        // `okLabel: '…'` either. One of these is the true half of a ternary
        // (`okLabel: forBuyer ? 'החזר לקונה' : 'סגור בלי החזר'`) which the strict form missed, and
        // the same words also appear as ordinary button text in menu markup, which the loose form
        // wrongly claimed. The line is the thing that is unambiguously a dialog's label.
        for (const m of src.matchAll(new RegExp(`okLabel:[^\\n]*'${label}'`, 'g'))) {
          const at = m.index ?? 0;
          // From the label to the END of its own spec, rather than a fixed window: `onConfirm` is
          // where every one of these objects stops describing itself and starts doing the work, and
          // a character count guessed instead would have to grow every time somebody writes a
          // comment — which is exactly how this check first reported a dialog that was correct.
          const stops = [src.indexOf('onConfirm', at), src.indexOf('okLabel:', at + 1)]
            .filter((i) => i > -1);
          const end = stops.length ? Math.min(...stops) : src.length;
          const spec = src.slice(Math.max(0, at - 400), end);
          // `tone:` AND a primary in it — the tone may itself be a ternary
          // (`tone: forBuyer ? ('primary' as const) : ('danger' as const)`), which is correct and
          // which a pattern demanding `tone: 'primary'` verbatim would reject.
          if (!(/tone:/.test(spec) && /'primary'/.test(spec))) offenders.push(`${file} — "${label}"`);
        }
      }
    }
    expect(
      offenders,
      "ConfirmModal defaults its OK button to the danger skin. A confirmation that APPROVES or\n"
      + "RESTORES something must pass tone: 'primary', or red stops meaning \"this takes something away\".",
    ).toEqual([]);
  });
});

describe('an .astro comment is never the first child of a && block', () => {
  const ASTRO = ['src/components', 'src/pages', 'src/layouts'].flatMap((d) => walk(d, /\.astro$/));

  it('scans the .astro tree', () => {
    expect(ASTRO.length).toBeGreaterThan(20);
  });

  it('finds no `&& (` immediately followed by a comment', () => {
    const offenders: string[] = [];
    for (const file of ASTRO) {
      // `&& (` at the end of a line, then whitespace, then `{/*` — the exact shape that compiles to
      // a 404 with no error message.
      if (/&&\s*\(\s*\n\s*\{\s*\/\*/.test(read(file))) offenders.push(file);
    }
    expect(
      offenders,
      'A comment there is a second sibling with no fragment around it: the page silently stops\n'
      + 'compiling and every route answers 404, naming no file. Move it ABOVE the `{cond && (`.',
    ).toEqual([]);
  });
});
