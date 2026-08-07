/**
 * A surface that speaks two languages must speak both everywhere.
 *
 * **The class.** Not "someone forgot to translate a screen" — that fails loudly and
 * somebody fixes it. The class is a surface that is 95% translated: the panel reads
 * `t.notifications`, the rows the client script writes into it are inline Hebrew.
 * Nothing throws, no test goes red, and the only symptom is an English shell around
 * Hebrew content, which nobody sees unless they browse the site in English. It had
 * already been caught twice on single files (`tests/orders-i18n.test.ts`,
 * `tests/buyer-dashboard-i18n.test.ts`), each time after the owner ran into it.
 *
 * When the 2026-08-07 area audit read the whole area, the same shape was in seven
 * more places, and in three of them **the dictionary already held the exact string**:
 * `t.notifications` had all nine of the bell's, `t.messages` all thirteen of the
 * compose dialog's, `t.dashboard` all five of the thread row's. Each side was right
 * on its own; only the join was missing.
 *
 * ## What decides that a file is in scope
 *
 * **It calls `getT(`.** That is the file saying, in its own code, that it renders in
 * whatever language the visitor picked — so every reader-visible string in it has to
 * come from somewhere that knows the language. A file with no `getT(` at all is a
 * Hebrew-only surface *by construction*, and hardcoding there is a decision rather
 * than drift: the admin panel (one user, the owner), an email template (the recipient's
 * language is not known at send time), a data vocabulary (`color-variants.ts`,
 * `store-taxonomy.ts`, the CSV column names sellers actually type). This is what makes
 * the rule self-maintaining and allowlist-free — the moment such a file gains its first
 * `getT(` call, every literal in it is held to the same standard, automatically.
 *
 * Two named exceptions, both because `getT` is called for a reason other than the copy:
 * the admin tree (it renders shared seller components that need a `lang`) and
 * `/terms`, which publishes Hebrew in both UI languages as a stated legal position
 * (AI_INSTRUCTIONS → i18n).
 *
 * ## What passes, and why — this is the part the audit needed
 *
 * There are 188 Hebrew literals in this tree that are perfectly correct, and telling
 * them apart from a bug is the whole difficulty. A literal passes when:
 *
 *  1. It is the fallback arm of `??` / `||`. `d.filterColStatus ?? 'סטטוס'` reads the
 *     dictionary and names a default for the case where the `#i18n-data` island or a
 *     `data-str-*` attribute is missing. The dictionary is the source; the literal is
 *     the floor. This is the dominant shape in every client renderer here.
 *  2. A language conditional decides it — `lang === 'he' ? 'הקודם' : 'Previous'`. Both
 *     languages are present, just inline instead of in `translations.ts`.
 *  3. It is a comment. Hebrew prose explaining a decision is wanted, not tolerated.
 *
 * Everything else is a string with no second language anywhere near it, which means it
 * renders in Hebrew no matter who is reading.
 *
 * ## The two deliberate blind spots, stated rather than hidden
 *
 * **Multi-line ternaries.** A conditional is looked for on the literal's own line and
 * the two lines above it, because `?` and its arms are routinely split across lines.
 * A ternary whose test sits four lines up would be excused wrongly. Widening the
 * window trades a missed bug for a false accusation, and a guard nobody trusts gets
 * deleted; three lines covers every shape in the tree today.
 *
 * **Regex character classes and single letters.** `.replace(/[ן]/g, 'נ')` in the
 * Hebrew search normaliser is matching machinery, not copy. Character classes are
 * blanked and one-character literals ignored: a lone Hebrew letter is a normalisation
 * target or a sort key, never a sentence anyone reads.
 *
 * Sits with the other tree-scanning "one rule, and the test that says so" guards:
 * `outbound-fetch`, `safe-redirect`, `money-guards`, `image-optimization`,
 * `retired-word-guard`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname` — this repo's own directory name is Hebrew, and
// `.pathname` hands back the percent-encoded form, which readdirSync cannot open.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const HEBREW = /[֐-׿]/;

/** A file is a bilingual surface once it asks the dictionary for anything. */
const DOES_I18N = /\bgetT\s*\(/;

/**
 * Out of scope, with the reason. Each entry is a place `getT` is called for
 * something other than this file's own copy.
 */
const HEBREW_ONLY: Array<{ prefix: string; why: string }> = [
  { prefix: 'pages/admin/', why: "the owner's own panel — one user, Hebrew; getT is here to hand a lang to shared seller components" },
  { prefix: 'components/admin/', why: 'same panel' },
  { prefix: 'scripts/admin/', why: 'same panel' },
  { prefix: 'pages/terms.astro', why: 'publishes Hebrew in BOTH UI languages, stated as the binding text (its own header says so)' },
  { prefix: 'i18n/', why: 'the dictionary itself' },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Path relative to `src/`, with forward slashes on every platform. */
function srcPath(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

/**
 * Blank out spans whose Hebrew is not a rendered string, keeping newlines so line
 * numbers survive: block comments (`/* *\/`, `{/* *\/}`, `<!-- -->`) and regex
 * character classes. Matched as spans rather than by stripping from a `//`, which
 * would swallow the rest of a line that holds a URL.
 */
function blankNonCopy(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  for (const [open, close] of [['/*', '*/'], ['<!--', '-->']] as const) {
    let at = source.indexOf(open);
    while (at !== -1) {
      const end = source.indexOf(close, at + open.length);
      const stop = end === -1 ? source.length : end + close.length;
      blank(at, stop);
      at = source.indexOf(open, stop);
    }
  }
  // `/[…]` — a regex literal opening on a character class.
  for (const m of source.matchAll(/\/\[[^\]\n]*\]/g)) blank(m.index, m.index + m[0].length);
  return out.join('');
}

/** The whole line is a comment. */
function isLineComment(line: string): boolean {
  return line.trim().startsWith('//');
}

/** `x ?? 'עברית'` / `x || 'עברית'` — the dictionary is the source, this is the floor. */
const HAS_FALLBACK = /(\?\?|\|\|)\s*[`'"]/;

/** A language conditional in the same statement. `dir` included: `getDir(lang)`'s output. */
const LANG_TEST = /\b(lang|isHe|isRtl|pageLang|dir)\b[^\n]{0,24}(===|!==|==|\?)|documentElement\.lang|\bisHe\b|\bisRtl\b/;

/** Hebrew that is a rendered string rather than a single letter of matching data. */
function hasRenderableHebrew(line: string): boolean {
  const run = line.match(/[֐-׿][֐-׿\s]*/g) ?? [];
  return run.some((r) => r.trim().length > 1);
}

describe('bilingual surfaces carry no hardcoded Hebrew', () => {
  const files = sourceFiles(SRC)
    .map((f) => ({ file: f, rel: srcPath(f) }))
    .filter(({ rel }) => !HEBREW_ONLY.some((e) => rel.startsWith(e.prefix)));

  it('has at least one file in scope (the scan itself still finds the tree)', () => {
    const inScope = files.filter(({ file }) => DOES_I18N.test(readFileSync(file, 'utf8')));
    expect(inScope.length).toBeGreaterThan(20);
  });

  it('routes every reader-visible string in a getT() file through the dictionary', () => {
    const offenders: string[] = [];
    for (const { file, rel } of files) {
      const raw = readFileSync(file, 'utf8');
      if (!DOES_I18N.test(raw)) continue;
      const lines = blankNonCopy(raw).split('\n');
      lines.forEach((line, i) => {
        if (!HEBREW.test(line) || isLineComment(line) || !hasRenderableHebrew(line)) return;
        if (HAS_FALLBACK.test(line)) return;
        // The statement, approximated: this line and the two above it (see header).
        if (LANG_TEST.test([line, lines[i - 1] ?? '', lines[i - 2] ?? ''].join('\n'))) return;
        offenders.push(`src/${rel}:${i + 1}  ${line.trim().slice(0, 110)}`);
      });
    }
    expect(
      offenders,
      'This file calls getT(), so it renders in both languages — a Hebrew literal here\n' +
        'shows Hebrew to an English reader and nothing fails. Move it to translations.ts\n' +
        "(check first: the key often already exists), or read it through `?? 'fallback'`\n" +
        'from the #i18n-data island / a data-str-* attribute if a client script writes it.\n' +
        `\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('horizontal prev/next controls mirror with the text direction', () => {
  /**
   * `lib/arrow-step.ts` makes ArrowLeft move a list FORWARD in RTL, because an arrow
   * key names a direction on screen. A button pinned to a physical side does not
   * mirror, so the keys and the buttons end up moving the same list opposite ways —
   * which is what the product lightbox did until 2026-08-07, while every other
   * carousel on the site (`.category-filters-arrow`, `.home-tabs-arrow`,
   * `.home-carousel-btn`) was already logical.
   */
  const STYLES = fileURLToPath(new URL('../src/styles/', import.meta.url));

  it('positions no --prev/--next selector with left or right', () => {
    const offenders: string[] = [];
    const cssFiles = (function walk(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (entry.endsWith('.css')) out.push(full);
      }
      return out;
    })(STYLES);

    for (const file of cssFiles) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!/--(prev|next|start|end)\b/.test(line)) return;
        if (!/(^|[^-\w])(left|right)\s*:/.test(line)) return;
        offenders.push(`${relative(SRC, file).split(sep).join('/')}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    expect(
      offenders,
      'A prev/next (or start/end) control is a direction ON SCREEN, so it has to mirror with\n' +
        '`dir`. Use inset-inline-start / inset-inline-end — and mirror the chevron with it,\n' +
        "either `[dir='rtl'] … svg { transform: scaleX(-1) }` or the inline `lang === 'he'`\n" +
        'style the other carousels use. Otherwise the buttons and the arrow keys disagree.\n' +
        `\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
