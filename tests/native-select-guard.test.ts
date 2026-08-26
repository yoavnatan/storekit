import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * No `<select>` on this site opens the OPERATING SYSTEM's menu.
 *
 * The rule is `feedback_no_native_dropdowns` and the mechanism is `initSelectDropdown`, which keeps
 * the real `<select>` — it stays the state, it still submits, `.value` still reads — and hides it
 * behind a mirrored trigger drawn in the site's own language. So the markup being a `<select>` is
 * correct and expected; what must never happen is one that nothing upgrades.
 *
 * **This guard exists because the rule was being followed almost everywhere.** Every filter in the
 * money log, all three in the reviews panel, both in the messages panel, every select in the boost
 * form and the whole clearing form were upgraded — and two were not: the admin statement's month
 * picker, and the coupon form's אחוז/סכום, whose identical twin one card away in `discount-field.ts`
 * was upgraded. A convention held in eight places out of ten is not a convention, it is a habit,
 * and the two exceptions were invisible precisely because everything around them was right.
 *
 * ── How it decides ───────────────────────────────────────────────────────────
 *
 * For every `<select id="…">` in a component or page, find the files that mention that id and
 * require at least one of them to call `initSelectDropdown`. A blanket
 * `querySelectorAll('select').forEach(initSelectDropdown)` satisfies it too, since the file doing
 * that also names the ids it later reads (the boost form). It is a heuristic, and it is the honest
 * one available to a static check: proving a call reaches a given element needs the DOM.
 *
 * A select with NO id is out of scope — nothing here can find its owner. That is a real hole and it
 * is stated rather than papered over; the fix if it ever matters is to require the id.
 */

/** An actual call. See the comment at the `covered` check for what matching the bare name cost. */
const CALLS_IT = /initSelectDropdown\s*\(/;

const ROOTS = ['src/components', 'src/pages'];
const SEARCHED = ['src/components', 'src/pages', 'src/scripts', 'src/lib'];

function walk(dir: string, ext: readonly string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, ext);
    return ext.some((e) => entry.name.endsWith(e)) ? [full] : [];
  });
}

/** `<select … id="the-id" …>` — the id may sit before or after the other attributes. */
function selectIds(source: string): string[] {
  const ids: string[] = [];
  for (const tag of source.match(/<select\b[^>]*>/g) ?? []) {
    const id = /\bid=["']([^"']+)["']/.exec(tag)?.[1];
    if (id) ids.push(id);
  }
  return ids;
}

describe('native dropdowns', () => {
  it('every <select> with an id is upgraded by initSelectDropdown', () => {
    const sources = SEARCHED.flatMap((root) => walk(path.join(process.cwd(), root), ['.ts', '.astro']))
      .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(path.join(process.cwd(), root), ['.astro'])) {
        const ids = selectIds(fs.readFileSync(file, 'utf8'));
        if (!ids.length) continue;
        /* Judged per COMPONENT, not per id, and the boost form is why: it upgrades all six of its
           selects with one `querySelectorAll('select')` loop, so five of the six ids appear in no
           `initSelectDropdown(...)` call anywhere. One script owns one component's controls, so if
           any of a component's select ids leads to a file that upgrades, that script is the owner
           and the blanket case is covered.

           The hole this leaves, stated rather than hidden: a component with two selects where only
           one is upgraded passes. Catching that needs the DOM, not a grep. */
        /* A CALL, not the word. The first version matched `initSelectDropdown` anywhere in the
           file and was fooled immediately: the doc comment left behind after the upgrade was
           removed still named the function, so the guard reported the control as covered while it
           opened the OS menu. Prose about a rule is not the rule. */
        const covered = ids.some((id) =>
          sources.some((s) => s.text.includes(id) && CALLS_IT.test(s.text)));
        if (!covered) offenders.push(`${path.relative(process.cwd(), file)} → ${ids.map((id) => `#${id}`).join(', ')}`);
      }
    }

    expect(offenders, [
      'A <select> nobody upgrades opens the browser\'s own menu: a different typeface, an arrow on',
      'the wrong side in RTL, and a popup that ignores the page\'s scrolling. Call',
      '`initSelectDropdown(el)` from the script that owns the control — and if anything assigns',
      '`.value` programmatically afterwards, `refreshSelectDropdown(el)` beside it, or the visible',
      'trigger keeps showing the old option while the select holds the new one.',
    ].join('\n')).toEqual([]);
  });
});
