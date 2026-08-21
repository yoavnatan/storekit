/**
 * A two-state toggle's HOVER may not wear the colour that means "on".
 *
 * The bug (owner, סשן ג׳, about the admin Messages tab): *"עשית באדמין את ה'סמן כטופל' עם הוי אבל
 * הוא לא מתנהג טוב, כי כשעומדים עליו הוא נראה כאילו הוא מסומן, ואין הבדל בין הובר לבין מסומן."*
 * `.msg-handled-mark:hover` previewed the action in `--color-success`, which is the one colour on
 * that control that already MEANS handled. Resting the pointer on an untreated thread drew the
 * exact picture a treated one draws, so the only way to read the real state was to move the mouse
 * away — on a control whose entire job is to report state without opening the row.
 *
 * It is a class, not an incident. The site's accent colours each have ONE job (AI_INSTRUCTIONS →
 * Design line, test 4), and spending one on a transient hover is how the signal it exists to carry
 * gets diluted. The Alerts tab's own resolve button had it right the whole time — neutral grey on
 * hover, green only when pressed — so this pins the pattern that was already there rather than
 * inventing one.
 *
 * **What this checks and what it deliberately does not.** It reads the resting `:hover` rule of
 * each toggle listed below and fails if that rule paints with the same token the toggle's PRESSED
 * rule uses. Hovering a toggle that is ALREADY on is exempt: deepening the same hue is the right
 * way to say "click to undo", and a second hue there would be a third meaning on a two-state
 * control.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

/**
 * Each entry: the stylesheet, the toggle's base selector, and how its ON state is written.
 * Add a row when a new icon toggle ships — the whole point is that the next one cannot repeat this.
 */
const TOGGLES = [
  {
    what: 'the admin Messages "טופל" mark',
    sheet: 'styles/utilities/utils.css',
    base: '.msg-handled-mark',
    on: '.msg-handled-mark[data-handled="1"]',
  },
  {
    what: 'the admin Alerts resolve button',
    sheet: 'styles/pages/admin.css',
    base: '.admin-alerts-resolve-btn',
    on: '.admin-alerts-resolve-btn[aria-pressed="true"]',
  },
];

/** Colour tokens named inside a declaration block. */
function tokensIn(block: string): string[] {
  return [...block.matchAll(/--color-[a-z-]+/g)].map((m) => m[0]);
}

/**
 * The body of the rule whose selector list contains `selector` exactly, and whose selector does
 * NOT also carry `:hover` unless asked for. Comments are stripped first so this file's own prose,
 * and the long rationale sitting above these rules, cannot satisfy or break a match.
 */
function ruleBody(css: string, selector: string, opts: { hover: boolean }): string | null {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = match[1]!.trim();
    const hasHover = sel.includes(':hover');
    if (hasHover !== opts.hover) continue;
    const head = opts.hover ? sel.replace(/:hover/g, '') : sel;
    if (head.split(',').some((s) => s.trim() === selector)) return match[2]!;
  }
  return null;
}

describe('a toggle\'s hover is not its on-state colour', () => {
  for (const t of TOGGLES) {
    it(`${t.what} hovers neutral`, () => {
      const css = readFileSync(join(SRC, t.sheet), 'utf8');

      const onBody = ruleBody(css, t.on, { hover: false });
      expect(onBody, `${t.on} not found in ${t.sheet}`).not.toBeNull();
      const onTokens = new Set(tokensIn(onBody!));
      expect(onTokens.size, `${t.on} paints with no colour token at all`).toBeGreaterThan(0);

      const hoverBody = ruleBody(css, t.base, { hover: true });
      expect(hoverBody, `${t.base}:hover not found in ${t.sheet}`).not.toBeNull();

      const shared = tokensIn(hoverBody!).filter((tok) => onTokens.has(tok));
      expect(
        shared,
        `${t.base}:hover paints with ${shared.join(', ')}, which is what ${t.on} means. `
        + 'Hover neutral (--color-text / --color-bg) and leave the state colour to the state.',
      ).toEqual([]);
    });
  }
});
