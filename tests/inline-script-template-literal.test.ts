/**
 * An `is:inline` script written as `set:html={`…`}` is ONE TEMPLATE LITERAL, and a backtick
 * anywhere inside it ends the literal.
 *
 * Cost, 2026-08-21: a comment added inside BaseLayout's site-wide notification poll quoted a
 * variable name in backticks — the house style for prose everywhere else in this repo. The literal
 * closed on the first one, the remaining JS was parsed as attributes on the `<script>` tag, and
 * every page of the site answered 500. Nothing in the suite saw it: vitest does not compile
 * `.astro`, so the failure only exists once something renders the page.
 *
 * The trap is entirely invisible while writing — the code reads correctly, the editor highlights
 * it correctly, and the mistake is in a COMMENT, which is the one place nobody looks for a syntax
 * error. `astro check` does catch it, but only after a full run; this fails in milliseconds and
 * says what to do.
 *
 * Scoped to `set:html={`…`}` rather than to inline scripts generally: a plain `<script>` block in
 * an `.astro` file is ordinary JS where a backtick is fine, and banning them there would be a rule
 * with no reason behind it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function astroFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) astroFiles(full, out);
    else if (full.endsWith('.astro')) out.push(full);
  }
  return out;
}

/** Every `set:html={` … `}` template-literal body in a file, with the line it starts on. */
function templateBodies(src: string): { body: string; line: number }[] {
  const out: { body: string; line: number }[] = [];
  const re = /set:html=\{\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    // The literal ends at the next backtick that is not escaped — which is the whole point: if a
    // stray one exists, THIS is where the block really ended, and everything after it was parsed
    // as markup rather than as script.
    let end = start;
    while (end < src.length) {
      if (src[end] === '\\') { end += 2; continue; }
      if (src[end] === '`') break;
      end++;
    }
    out.push({ body: src.slice(start, end), line: src.slice(0, m.index).split('\n').length });
    re.lastIndex = end + 1;
  }
  return out;
}

describe('an is:inline set:html script is one template literal', () => {
  it('no such block is cut short by a stray backtick', () => {
    const offenders: string[] = [];
    let blocks = 0;
    for (const file of astroFiles('src')) {
      const src = readFileSync(file, 'utf8');
      for (const { body, line } of templateBodies(src)) {
        blocks++;
        // A block that really ends where it should closes its own IIFE / statement. One cut short
        // by a backtick in a comment ends mid-word, so what follows the literal is not markup.
        const after = src.slice(src.indexOf(body, 0) + body.length + 1).trimStart();
        if (!after.startsWith('}')) {
          offenders.push(`${file}:${line} — the literal does not end at a \`}\`; a stray backtick closed it early`);
        }
      }
    }
    expect(blocks, 'no set:html template blocks found — the scan is broken').toBeGreaterThan(0);
    expect(
      offenders,
      `Remove the backtick (a comment counts). The whole script is one template literal, so one
backtick ends it and the rest of the file is parsed as attributes on the script tag:
${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
