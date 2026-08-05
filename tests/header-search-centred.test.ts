import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The header's search bar sits on the row's TRUE centre, at every desktop width.
 *
 * It is centred by a 3-column grid whose two outer tracks are the same size — that equality is
 * the whole mechanism, and it is the thing that gets broken by accident. It already was: to stop
 * a long store name being squeezed, the row used to swap in an asymmetric
 * `minmax(6rem,auto) minmax(7rem,1fr) auto` under 1024px, which bought the name its width by
 * pushing the bar off centre — measured 136px off on a 1000px window, on every page with a search
 * bar, the homepage included (its logo column is 69px wide and had nothing to protect).
 *
 * The replacement gives each outer track a FLOOR instead, so the name/icons are protected without
 * the tracks ever being written unequal. This test guards the shape, not the numbers: one
 * grid-template-columns for that row, its outer tracks identical, and the middle one a range the
 * row can shrink (an `auto` middle track takes the bar's own width as a floor and overflows the
 * row instead of giving way).
 */
const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/components/header.css'), 'utf8');

/** Split a track list on its top-level spaces — every track here has spaces inside a minmax(). */
function splitTracks(template: string): string[] {
  const tracks: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of template) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) {
      if (current) tracks.push(current);
      current = '';
    } else current += ch;
  }
  if (current) tracks.push(current);
  return tracks;
}

describe('the header search bar is centred', () => {
  const templates = [...css.matchAll(/\.site-header \.container:has\(> \.header-search\)\s*\{([^}]*)\}/g)]
    .map((m) => m[1].match(/grid-template-columns:\s*([^;]+);/)?.[1].trim())
    .filter((t): t is string => !!t);

  it('is templated exactly once — no media query re-templates the row', () => {
    expect(templates).toHaveLength(1);
  });

  const tracks = templates.length === 1 ? splitTracks(templates[0]) : [];

  it('gives the two outer tracks the same definition, which is what centres the middle one', () => {
    expect(tracks).toHaveLength(3);
    expect(tracks[0]).toBe(tracks[2]);
  });

  it('lets the search track shrink — a bare `auto` middle track overflows the row instead', () => {
    expect(tracks[1]).not.toBe('auto');
    expect(tracks[1]).toMatch(/^minmax\(/);
  });
});
