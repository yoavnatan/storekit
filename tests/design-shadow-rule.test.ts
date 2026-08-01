import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The elevation guard.
 *
 * User instruction (2026-08-01): "design elements are supposed to be functional
 * and meaningful." A site-wide audit that day found 279 shadow declarations,
 * most of them sitting at rest on surfaces that do not move — the product page's
 * hero image, every card in every grid, stat tiles, pressed chips, a store's
 * banner. A shadow that is on everything says nothing, and it made the hover
 * shadow unreadable too: it was only ever a slightly deeper version of what was
 * already there.
 *
 * THE RULE (written in full on the tokens themselves, src/styles/base/tokens.css):
 * a shadow means "this floats ABOVE the page", so only a surface that genuinely
 * floats carries one at rest. Everything in normal flow is border + surface, and
 * takes depth on hover if it is clickable.
 *
 * This test is the mechanical half. It scans every stylesheet and every .astro /
 * .ts file for the shared shadow TOKENS (--shadow-xs / --shadow-card / --shadow-bar)
 * applied at rest, and fails unless the surface is on the FLOATING allowlist below with a
 * reason next to it. It deliberately does not police one-off rgba() shadows:
 * those are the modals, drawers and tooltips, which are floating by definition.
 *
 * `--shadow-overlay` and `--shadow-sheet` (added 2026-08-02) are left out of the scan for the
 * same reason, not by oversight: they are named for the two populations that float by
 * definition — a dialog over a scrim, a panel slid in from a viewport edge — so scanning them
 * would only generate allowlist entries for surfaces nobody could argue are in flow. What the
 * scan is for is the tokens a flat surface might plausibly be given: xs / card / bar.
 *
 * When this fails: delete the shadow. Adding an allowlist entry is only correct
 * when the surface is fixed/sticky/absolutely-positioned OVER other content —
 * and the entry has to say so, because an allowlist nobody has to justify is how
 * this rule rots back to 279.
 */

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** Surfaces that genuinely float, and may therefore keep a token shadow at rest. */
const FLOATING = new Map<string, string>([
  ['.toast-card', 'fixed toast stack, covers the page'],
  ['.cart-preview', 'popover anchored to the header cart button'],
  ['.store-details__content', 'popover over the store header (z-index above the sticky toolbar)'],
  ['.admin-msg-seller-dd__menu', 'dropdown menu'],
  ['.home-tabs-arrow', 'absolute arrow over the tab strip it scrolls'],
  ['.home-carousel-btn', 'absolute arrow over the carousel it scrolls'],
  ['.category-filters-arrow', 'absolute arrow over the filter row it scrolls'],
  ['.overflow-shadow', 'only ever added while content is really scrolled behind the footer'],
  ['.store-banner', 'the curtain: it travels over the pinned banner for the whole scroll'],
  // Added 2026-08-02, when every overlay's hand-rolled rgba(0,0,0,…) was replaced by the
  // tokens (18 of them, pure black, blurs 14→60px). They were invisible to this guard only
  // because they were hand-rolled; each one floats, and now says so here.
  ['.notif-dropdown', 'dropdown anchored to the header bell'],
  ['.user-dropdown', 'dropdown anchored to the header account button'],
  ['.header-search__dropdown', 'search suggestions, absolutely positioned over the page'],
  ['.category-chip-dropdown', 'dropdown anchored to a category chip'],
  ['.cart-info__bubble', 'tooltip bubble over the cart drawer'],
  ['.gallery-slot__check', 'absolute selection badge over the thumbnail it marks'],
  ['#sticky-cart-bar', 'fixed mobile buy bar — the product page scrolls under it'],
]);

const REST_EXEMPT = /:hover|:focus|:active|:focus-visible|\[aria-expanded="true"\]/;

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, acc);
    else if (exts.some((e) => entry.name.endsWith(e))) acc.push(full);
  }
  return acc;
}

/** Strip /* … *\/ comments so a rule quoted in prose never counts as code. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * The selector a `box-shadow:` line belongs to: either on the same line (a
 * one-line rule) or the nearest preceding line that opens a block. Good enough
 * for this codebase's formatting, and it fails loudly rather than silently if a
 * shadow ever appears with no selector above it.
 */
function selectorFor(lines: string[], index: number): string {
  if (lines[index].includes('{')) return lines[index].slice(0, lines[index].indexOf('{')).trim();
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.endsWith('{')) return line.slice(0, -1).trim();
  }
  return '(no selector found)';
}

type Finding = { file: string; line: number; where: string };

function scanStylesheet(file: string, text: string): Finding[] {
  const lines = stripComments(text).split('\n');
  const out: Finding[] = [];
  lines.forEach((line, i) => {
    if (!/box-shadow\s*:/.test(line)) return;
    if (!/var\(--shadow-(xs|card|bar-up|bar)\)/.test(line)) return; // --shadow-hover* are hover-only by name; --shadow-bar is deleted but still scanned, so re-adding it is a decision
    const selector = selectorFor(lines, i);
    if (REST_EXEMPT.test(selector)) return;
    if ([...FLOATING.keys()].some((s) => selector.includes(s))) return;
    out.push({ file, line: i + 1, where: selector });
  });
  return out;
}

/**
 * Is the element carrying this line positioned OVER the page rather than sitting in flow?
 * That is the only question the elevation rule asks, so an element that answers it in its own
 * markup needs no allowlist entry — checked instead of allowlisting whole FILES (the older
 * FLOATING_MARKUP shape), because "this file may use shadows" is a far weaker claim than "this
 * element is out of flow", and it blesses every other surface in the same file.
 *
 * Looks back over the opening tag, not just the matched line: a multi-line tag routinely puts
 * `class="absolute …"` and `style="…box-shadow…"` on separate lines. Stops at the tag's own
 * `<`, so a SIBLING's positioning can never vouch for this element. Added 2026-08-02.
 */
function positionedOutOfFlow(lines: string[], index: number): boolean {
  const POSITIONED = /position\s*:\s*(?:fixed|absolute)|class="[^"]*\b(?:fixed|absolute)\b/;
  for (let i = index; i >= 0 && i > index - 12; i--) {
    if (POSITIONED.test(lines[i])) return true;
    if (/^\s*<\w/.test(lines[i])) return false;
  }
  return false;
}

function scanMarkup(file: string, text: string): Finding[] {
  const lines = text.split('\n');
  const out: Finding[] = [];
  lines.forEach((line, i) => {
    // Tailwind utility form: shadow-[var(--shadow-xs)] / [box-shadow:var(--shadow-card)]
    const utility = /(^|[\s"'`])(shadow-\[var\(--shadow-(?:xs|card|bar-up|bar)\)\]|\[box-shadow:var\(--shadow-(?:xs|card|bar-up|bar)\)\])/;
    // Inline style form: style="…box-shadow:var(--shadow-xs)…"
    const inline = /box-shadow\s*:\s*var\(--shadow-(?:xs|card|bar-up|bar)\)/;
    if (!utility.test(line) && !inline.test(line)) return;
    if (positionedOutOfFlow(lines, i)) return;
    out.push({ file, line: i + 1, where: line.trim().slice(0, 110) });
  });
  return out;
}

describe('elevation rule: a shadow means the surface floats', () => {
  const stylesheets = walk(join(SRC_DIR, 'styles'), ['.css']);
  const markup = walk(SRC_DIR, ['.astro', '.ts']);

  it('finds the files it is meant to guard', () => {
    expect(stylesheets.length).toBeGreaterThan(10);
    expect(markup.length).toBeGreaterThan(50);
  });

  it('no at-rest --shadow-xs / --shadow-card / --shadow-bar in a stylesheet outside the floating allowlist', () => {
    const findings = stylesheets.flatMap((f) => {
      const rel = relative(SRC_DIR, f);
      return scanStylesheet(rel, readFileSync(f, 'utf8'));
    });
    expect(
      findings.map((f) => `${f.file}:${f.line} — ${f.where}`),
      'A surface in normal flow gets border + --color-surface, no shadow. Delete it, or ' +
        'add the selector to FLOATING in this file WITH the reason it floats.',
    ).toEqual([]);
  });

  it('no at-rest shadow-token utility/inline style in .astro or .ts unless the element is out of flow', () => {
    const findings = markup.flatMap((f) => {
      const rel = relative(SRC_DIR, f);
      // A <style> block inside .astro is CSS — let the stylesheet scanner judge
      // it, so a sticky-bar selector can be allowlisted the same way.
      const text = readFileSync(f, 'utf8');
      const cssBlocks = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
      const markupOnly = text.replace(/<style[^>]*>[\s\S]*?<\/style>/g, (m) => m.replace(/[^\n]/g, ''));
      const fromCss = cssBlocks.flatMap((block, n) => scanStylesheet(`${rel} <style#${n + 1}>`, block));
      return [...fromCss, ...scanMarkup(rel, markupOnly)];
    });
    expect(
      findings.map((f) => `${f.file}:${f.line} — ${f.where}`),
      'Same rule as the stylesheets: flat at rest, depth on hover (hover:shadow-[…] is fine).',
    ).toEqual([]);
  });

  it('the rule itself is documented where the tokens are handed out', () => {
    const tokens = readFileSync(join(SRC_DIR, 'styles/base/tokens.css'), 'utf8');
    expect(tokens).toContain('floats ABOVE the page');
    expect(tokens).toContain('--shadow-xs');
  });
});
