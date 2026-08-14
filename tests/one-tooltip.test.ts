/**
 * The site has ONE tooltip, and `title` is not it.
 *
 * `title` is the BROWSER's tooltip: a different font, a different colour, its own slow timing, and
 * it appears wherever the OS decides. Beside a site with a designed tooltip of its own it reads as
 * a piece of another application — which is exactly how the owner reported it (2026-08-14, the
 * copy-address buttons in the dashboard header and in the domain settings).
 *
 * Nothing had to be built to fix it: `scripts/icon-tooltips.ts` already labels every icon-only
 * control from its `aria-label`, and it deliberately SKIPS any element carrying a `title` so the
 * two can never both appear. So an icon button with `title="X" aria-label="X"` is not a button with
 * two labels — it is a button that opted OUT of the site's tooltip by repeating itself. Deleting
 * the attribute is the whole fix, and it also lets the label follow a state change (the copy button
 * swaps its `aria-label` to "הועתק" while the tick is up; a static `title` never moved).
 *
 * ## What this test bans, and what it deliberately does not
 *
 * Only the exact duplicate — `title` and `aria-label` set to the SAME expression on one element.
 * That is the shape with no defensible reading, and it is mechanical to detect in both markup
 * (`title={x} aria-label={x}`) and template strings (`title="${x}" aria-label="${x}"`).
 *
 * A `title` that says something DIFFERENT from the accessible name is left alone: it may be the
 * only sighted label an element has, and two of them are legitimate today —
 *   · the product table's SEO column heading, whose content is the word "SEO" rather than a glyph,
 *     so `icon-tooltips.ts` cannot cover it (it now uses `data-tooltip`, the explicit opt-in);
 *   · the private-note chip, whose `title` is the note itself — up to 2000 characters, which the
 *     site's tooltip (max-width 15rem) would render as a wall of text.
 * Both are decisions rather than drift, which is why the rule is written this narrowly.
 *
 * And it only holds elements the site's tooltip can actually REACH — the same predicate
 * `icon-tooltips.ts` uses: `button`, `a`, `summary`, `[role="button"]`. On anything else (the SEO
 * gauge is a `<span role="img">`) removing `title` would take away the hover label and put nothing
 * in its place, so the duplicate there is the lesser evil. This is a narrowed RULE rather than an
 * allowlist on purpose: a list of excused files is a second definition of the rule, and it rots.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every `.astro` / `.ts` file under `src/`. A tree walk, not a file list — the next surface to
 *  grow an icon button is covered the day it exists. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(astro|ts)$/.test(entry.name) && statSync(full).size > 0) out.push(full);
  }
  return out;
}

/** One attribute value, in any of the three spellings these files use. */
const VALUE = String.raw`(\{[^{}]*\}|"[^"]*"|'[^']*')`;
const TITLE_THEN_LABEL = new RegExp(String.raw`title=${VALUE}\s+aria-label=${VALUE}`, 'g');
const LABEL_THEN_TITLE = new RegExp(String.raw`aria-label=${VALUE}\s+title=${VALUE}`, 'g');

/** Is the element these attributes sit on one the site's own tooltip would label? Mirrors
 *  `icon-tooltips.ts#candidate`: it reaches back to the tag this attribute belongs to. */
function siteTooltipCanReach(src: string, at: number): boolean {
  const open = src.lastIndexOf('<', at);
  if (open < 0) return false;
  const head = src.slice(open, at);
  return /^<(button|a|summary)[\s>]/.test(head) || /role=["'{]?button/.test(head);
}

describe('one tooltip, not two', () => {
  it('has no control whose title merely repeats its accessible name', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const [re, ti, li] of [[TITLE_THEN_LABEL, 1, 2], [LABEL_THEN_TITLE, 2, 1]] as const) {
        re.lastIndex = 0;
        for (const m of src.matchAll(re)) {
          if (m[ti] !== m[li]) continue;
          if (!siteTooltipCanReach(src, m.index)) continue;
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${file.replace(process.cwd() + '/', '')}:${line} — ${m[ti]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scanned a tree that actually contains the surfaces this is about', () => {
    // Guards the guard: a moved directory would otherwise make the scan above vacuously pass.
    const files = sourceFiles(join(process.cwd(), 'src')).map((f) => f.replace(process.cwd() + '/', ''));
    expect(files).toContain('src/components/dashboard/CopyButton.astro');
    expect(files).toContain('src/scripts/icon-tooltips.ts');
    expect(files.length).toBeGreaterThan(200);
  });
});
