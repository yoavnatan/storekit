/**
 * The narrow-card rules only exist if something is a container — and if they stop
 * applying, nothing anywhere goes red.
 *
 * A store card on a phone is 166px wide (two to a row), which leaves 64px beside
 * the 56px avatar for the store's name and tagline: every tagline on the homepage
 * was ellipsised mid-word and the invite cards read "מתחם …" (owner, 2026-08-16).
 * The fix stacks the head, and it is keyed to the CARD's width rather than the
 * viewport's — a `@container` query — because the same 375px phone renders this
 * card at 166px on a shelf and at 343px on /stores, and only one of those needs it.
 *
 * An unnamed `@container` query resolves against the nearest ancestor that
 * declares `container-type`. Delete that one declaration — or move the block to a
 * stylesheet whose card never got it — and the query matches NOTHING: no error, no
 * warning, no failing selector, just a phone quietly back to cut-off text on a
 * surface nobody re-tests on a phone. That silence is what this guards.
 *
 * The second case guards the alignment contract the stacked head has to keep. A
 * head that is taller on one card than on its neighbour puts their picture rows at
 * different heights, which is the misalignment the owner photographed on
 * 2026-08-14 (StorePlaceholderCard's own note records the override that caused it).
 * The two-line tagline holds only because its height is FIXED — a `min-height`, or
 * a clamp with no height at all, reintroduces exactly that bug for any store whose
 * tagline happens to be one line long.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CARD_CSS = path.join(process.cwd(), 'src/styles/components/store-card.css');
const css = fs.readFileSync(CARD_CSS, 'utf8');

/** The `@container <condition>` blocks in this file, with their bodies. */
function containerBlocks(source: string): string[] {
  const out: string[] = [];
  const re = /@container[^{]*\{/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    // Walk braces from the block's own `{` so nested rules come along whole.
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}' && (depth -= 1) === 0) break;
    }
    out.push(source.slice(start + 1, i));
  }
  return out;
}

describe('the store card is the container its own narrow rules query', () => {
  const blocks = containerBlocks(css);

  it('has the query it is written to protect, so this is not a no-op', () => {
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.join('')).toMatch(/\.store-card__head/);
  });

  it('declares container-type on .store-card itself', () => {
    // The TOP-LEVEL rule, matched at column 0 — everything inside a query block
    // is indented, and a card that establishes its context only inside the query
    // it is meant to answer would never establish it at all.
    const base = css.match(/^\.store-card\s*\{([\s\S]*?)\}/m)?.[1] ?? '';
    expect(base).toMatch(/container-type:\s*inline-size/);
  });

  it('reserves the stacked tagline a FIXED height, not a minimum', () => {
    const tagline = blocks
      .join('\n')
      .match(/\.store-card__tagline\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(tagline, 'the narrow-card block no longer styles the tagline').toMatch(/line-clamp/);
    expect(tagline, 'a min-height lets a one-line tagline shrink its card head below its neighbour').toMatch(/(^|[\s;])height:/);
    expect(tagline).not.toMatch(/min-height:/);
  });
});
