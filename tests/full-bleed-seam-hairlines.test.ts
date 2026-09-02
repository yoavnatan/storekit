/**
 * At full bleed, a seam carries ONE hairline — not one from each side.
 *
 * On a phone (≤640px) the store banner picture and the details box below it lose their radius and
 * their side borders and run edge to edge, and their vertical padding goes to zero (store.css, the
 * `max-width: 640px` block). Both were still drawing their own top AND bottom border, so at every
 * seam two 1px lines met with nothing between them and printed as a 2px rule (owner, 2026-09-02:
 * *"באנר של חנות במובייל מקבל בורדר כפול, למעלה ולמטה"*).
 *
 * Measured at 390px before the fix, in document order:
 *
 *   demo strip   border-bottom  116.4 → 117.4
 *   image wrap   border-top     117.4 → 118.4     ← 2px at the top seam
 *   image wrap   border-bottom  246.4 → 247.4
 *   .store-info  border-top     247.4 → 248.4     ← 2px at the bottom seam
 *
 * Inset, this cannot happen: each card is surrounded by white, and its own line is the only thing
 * at its edge. Full bleed removes the white and the two lines become neighbours — the same shape
 * problem the paddings in that block were already zeroed for.
 *
 * The picture's lines are the ones that go: `.store-info`'s pair draws the details box on both
 * edges and is needed there, and the line above the picture belongs to the demo strip or the site
 * header, neither of which this page may edit. So the picture keeps no border of its own on a
 * phone and each seam is drawn once, by the element that still needs it.
 */
import { describe, it, expect } from 'vitest';
import { sourceGuard, readSource } from './helpers/source-guard.js';

const CSS_FILE = 'src/styles/pages/store.css';

/**
 * Every `@media (max-width: 640px)` body in the file, concatenated — the page's phone rules.
 *
 * ALL of them, not the first: this stylesheet opens several such blocks (the search row has its
 * own, well above the banner's), and a slice that stopped at the first one would be reading a
 * different part of the page while reporting on this one.
 */
function phoneBlock(css: string): string {
  const MQ = '@media (max-width: 640px)';
  const bodies: string[] = [];
  for (let at = css.indexOf(MQ); at !== -1; at = css.indexOf(MQ, at + MQ.length)) {
    const open = css.indexOf('{', at);
    if (open === -1) break;
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { bodies.push(css.slice(open + 1, i)); break; }
    }
  }
  return bodies.join('\n');
}

describe('the phone-width store banner', () => {
  it('drops the picture frame that would double every seam', () => {
    // Asserted here as well as inside the helper — see source-guard.ts on why the return value
    // exists: a test whose only assertion hides in a helper reads as a test that asserts nothing.
    expect(sourceGuard({
      file: CSS_FILE,
      rule: 'at ≤640px `.store-banner__image-wrap` draws no top/bottom border of its own',
      find: (css) => {
        const block = phoneBlock(css);
        if (!block) return ['the @media (max-width: 640px) block was not found'];
        return /\.store-banner__image-wrap\s*\{[^}]*border-block:\s*0/.test(block)
          ? []
          : ['no `border-block: 0` for .store-banner__image-wrap inside the phone block'];
      },
      // The phone block as it stood while both seams printed 2px lines.
      mustReject: `@media (max-width: 640px) {
        .store-banner__image-wrap, .store-info { margin-inline: 0; border-radius: 0; border-inline: 0; }
        .store-banner { padding-top: 0; padding-bottom: 0; }
      }`,
    })).toEqual([]);
  });

  it('leaves the details box its own two lines — they are what draws the seams now', () => {
    const css = readSource(CSS_FILE);
    const at = css.indexOf('.store-info {');
    const body = css.slice(at, css.indexOf('}', at));
    expect(body, '.store-info keeps a full border; only its side borders go at ≤640px')
      .toMatch(/border:\s*1px solid var\(--color-border\)/);
    expect(phoneBlock(css), 'the phone block must not zero .store-info\'s block borders too')
      .not.toMatch(/\.store-info\s*\{[^}]*border-block:\s*0/);
  });

  it('reads a real block, so the rules above cannot pass on an empty slice', () => {
    expect(phoneBlock(readSource(CSS_FILE))).toContain('.store-banner-pin');
    expect(phoneBlock('@media (max-width: 640px) { .a { b: c; } }')).toBe(' .a { b: c; } ');
    expect(phoneBlock('.x { y: z; }')).toBe('');
  });
});
