/**
 * A `<td>` given `display: flex` (or grid) STOPS BEING A TABLE CELL, and the row comes apart.
 *
 * This is not a specificity or a cascade problem, it is the box tree. `display` on a table-cell is
 * not a decoration on top of the cell — it *is* what makes the element a cell. Change it to `flex`
 * and CSS's anonymous-table-object rules step in: the browser wraps the now-flex box in an
 * ANONYMOUS table cell, and that anonymous cell is reachable by nothing. Not the `<colgroup>`
 * width, not `.admin-table td { padding; border-bottom }`, not the row's `:hover`. So the column
 * sizing skips it, the row's bottom border stops before it, and everything after it slides — the
 * row visibly breaks in half part-way across.
 *
 * Found on 2026-08-07 on the admin Alerts tab: `.admin-alerts-actions` (a `<td>` holding three icon
 * buttons) carried `display: flex`, and the owner's screenshot showed the message text running out
 * past the table's edge with the buttons floating loose beside it. The fix is always the same and
 * costs one element: keep the `<td>` a `<td>`, put the flex on a `<div>` inside it.
 *
 * **Why the rule is scoped to rules OUTSIDE `@media`.** Turning a table into a card list at phone
 * width is a real, deliberate pattern here (`#admin-alerts-table` and `.msg-table` both do it): the
 * whole table is dismantled — `table`, `tbody`, `tr` and `td` all get `display: block`/`flex`/
 * `grid` together — so there is no table left for an anonymous cell to be generated inside, and
 * flex on a `td` is then exactly right. That dismantling only ever happens inside a media query.
 * A rule at the top level applies while the element is still a genuine cell in a genuine table,
 * which is the case this forbids.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Drop every `@media`/`@supports`/`@container` block, braces balanced.
 *
 * Regex cannot do this (the blocks nest), and getting it wrong in the lenient direction would make
 * the guard pass on the very rule it exists to catch — so it is a scanner, not a pattern.
 */
function topLevelOnly(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] !== '@' || !/^@(media|supports|container)\b/.test(css.slice(i, i + 12))) {
      out += css[i];
      i += 1;
      continue;
    }
    // Walk to this at-rule's opening brace, then past its matching close.
    let j = css.indexOf('{', i);
    if (j === -1) break;
    let depth = 1;
    j += 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    i = j;
  }
  return out;
}

/** Every class name this codebase puts on a `<td>` or a `<th>`. */
function tableCellClasses(): Map<string, string> {
  const owner = new Map<string, string>();
  for (const file of walk(SRC, '.astro')) {
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<(td|th)\b[^>]*?\bclass=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)) {
      const raw = [m[2], m[3], m[4]].filter(Boolean).join(' ');
      // A dynamic class expression still carries its literals; take those and ignore the code.
      for (const lit of raw.matchAll(/[A-Za-z][A-Za-z0-9_-]*/g)) {
        if (!owner.has(lit[0])) owner.set(lit[0], file.replace(`${process.cwd()}/`, ''));
      }
    }
  }
  return owner;
}

const BREAKS_THE_CELL = /(?:^|[;{\s])display\s*:\s*(?:inline-)?(?:flex|grid)\s*(?:;|$|!)/;

describe('a table cell keeps table-cell display', () => {
  it('has no top-level rule giving display:flex/grid to a class used on a <td> or <th>', () => {
    const cells = tableCellClasses();
    // Sanity: if the markup scan silently found nothing, every assertion below is vacuous.
    expect(cells.size).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'styles'), '.css')) {
      const css = topLevelOnly(stripComments(readFileSync(file, 'utf8')));
      for (const rule of css.matchAll(/(^|\})\s*([^{}@]+)\{([^{}]*)\}/g)) {
        const [, , selector, block] = rule;
        if (!BREAKS_THE_CELL.test(block!)) continue;
        for (const [cls, astro] of cells) {
          // The selector must END on that class (`.x`, `td.x`, `.a .x`) — a rule for `.x > div`
          // or `.x button` styles a child, which is a normal box and free to be a flex container.
          if (!new RegExp(`\\.${cls}\\s*$`).test(selector!.trim())) continue;
          offenders.push(
            `${file.replace(`${process.cwd()}/`, '')}: "${selector!.trim()}" — .${cls} is a <td>/<th> class in ${astro}. `
            + 'Move the flex/grid to a wrapper element inside the cell.',
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
