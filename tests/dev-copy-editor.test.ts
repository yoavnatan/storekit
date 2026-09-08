/**
 * The inline copy editor: it must never exist outside `astro dev`, and it must never damage a
 * string on its way into `src/i18n/translations.ts`.
 *
 * The first half is the one that matters most. This is a route that WRITES SOURCE FILES on an
 * unauthenticated POST — correct for a dev server, and a remote-code-shaped hole on a deployed one.
 * Two independent things keep it out: `BaseLayout` renders the client behind `import.meta.env.DEV`,
 * and the route itself returns 404 unless the same constant is true. Either alone would be enough
 * today; both are pinned because "the bundler drops it" is a claim about a build nobody re-checks,
 * and because a future refactor that mounts the component from somewhere else must fail here rather
 * than ship.
 *
 * Both guards go through `sourceGuard`, so each is run against a counter-example it has to reject —
 * `feedback_guards_must_be_proved_to_fail`.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sourceGuard } from './helpers/source-guard.js';
import {
  validateEdit,
  tidy,
  placeholdersOf,
  mayRewriteFallbacks,
  mergeEnglishTodo,
  regenerateFor,
  REGENERATE_AFTER,
} from '../src/lib/dev-copy-edit.js';
import { devCopyMap } from '../src/lib/dev-copy-map.js';
import { scanLanguageBlock, replaceLeaves } from '../scripts/lib/translations-source.mjs';

const REPO = path.join(import.meta.dirname, '..');

describe('the editor cannot reach production', () => {
  it('the write-back route refuses unless the dev server is what is running', () => {
    // The rule is a REQUIRED line, so the offender list is "the guard is missing" — and the
    // counter-example is the same route with the check taken out, which is exactly the diff a
    // refactor would produce.
    const offenders = sourceGuard({
      file: 'src/pages/api/dev/copy.ts',
      rule: 'POST must return 404 unless import.meta.env.DEV',
      find: (src) =>
        /if\s*\(\s*!import\.meta\.env\.DEV\s*\)\s*return new Response\([^)]*\{\s*status:\s*404/.test(src)
          ? []
          : ['no `if (!import.meta.env.DEV) return … 404` in the POST handler'],
      mustReject: `
        export const POST: APIRoute = async ({ request }) => {
          const body = await readJsonBody(request, BODY_LIMIT.control);
          fs.writeFileSync(SOURCE, 'whatever', 'utf8');
        };
      `,
    });
    expect(offenders).toEqual([]);
  });

  it('BaseLayout mounts the editor only behind the same constant', () => {
    const offenders = sourceGuard({
      file: 'src/layouts/BaseLayout.astro',
      rule: '<CopyEditor /> is rendered only inside an import.meta.env.DEV guard',
      find: (src) => {
        const mounts = [...src.matchAll(/<CopyEditor\s*\/>/g)];
        return mounts
          .filter((m) => !/import\.meta\.env\.DEV\s*&&\s*$/.test(src.slice(0, m.index).trimEnd() + ' '))
          .map(() => 'an unguarded <CopyEditor /> mount');
      },
      mustReject: '<MessageCompose />\n    <CopyEditor />',
    });
    expect(offenders).toEqual([]);
  });

  it('nothing outside the dev editor imports the un-gated dictionary', () => {
    // `dev-copy-map.ts` flattens all ~1,200 Hebrew strings. It is harmless where it is; imported by
    // a real page it would put the seller dashboard's copy into an anonymous shopper's HTML, which
    // is the exact weight BaseLayout's `#i18n-data` slicing exists to avoid.
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|astro)$/.test(full) && fs.readFileSync(full, 'utf8').includes('dev-copy-map')) {
          importers.push(path.relative(REPO, full));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    expect(importers.sort()).toEqual(['src/components/dev/CopyEditor.astro']);
  });
});

describe('a string is reworded, never damaged', () => {
  it('asks before emptying a string, and does it when asked again', () => {
    // Deleting a line of copy is ordinary work (owner, 2026-09-08: *"אם אני רוצה למחוק שורה, זה לא
    // נותן"*), so this is a question rather than a refusal — `confirm` is what tells the panel to
    // offer the second press instead of just printing an error.
    const asked = validateEdit('שלח הודעה', '   ');
    expect(asked.ok).toBe(false);
    expect(asked.ok === false && asked.confirm).toBe('empty');

    expect(validateEdit('שלח הודעה', '   ', true)).toEqual({ ok: true, value: '' });
  });

  it('does not let the confirmation buy anything else', () => {
    // `allowEmpty` says one thing: an empty result is intended. A dropped placeholder in a
    // NON-empty string is still damage, and the second press must not wave it through.
    expect(validateEdit('נשלחו {n} הודעות', 'נשלחו הודעות', true).ok).toBe(false);
  });

  it('refuses a lost placeholder, naming the one that went missing', () => {
    const result = validateEdit('נשלחו {n} הודעות', 'נשלחו הודעות');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('{n}');
  });

  it('accepts a rewrite that keeps the placeholder, wherever it moved to', () => {
    expect(validateEdit('נשלחו {n} הודעות', 'שלחנו לך {n} הודעות')).toEqual({
      ok: true,
      value: 'שלחנו לך {n} הודעות',
    });
  });

  it('tidies the marks hand-editing leaves, and says so by returning the tidied text', () => {
    expect(tidy('  שתי  מילים ')).toBe('שתי מילים');
    expect(validateEdit('א', '  ניתן  לשלוח ')).toEqual({ ok: true, value: 'ניתן לשלוח' });
  });

  it('sorts placeholders so two lists compare directly', () => {
    expect(placeholdersOf('{b} ו-{a}')).toEqual(['{a}', '{b}']);
  });
});

describe('the hard-coded copies in client renderers', () => {
  it('are rewritten only when the old text belongs to exactly one key', () => {
    expect(mayRewriteFallbacks(['שלח', 'בטל', 'שמור'], 'שלח')).toBe(true);
    // The same words under two keys: which renderer's fallback is which cannot be known from the
    // literal alone, so the editor reports instead of guessing.
    expect(mayRewriteFallbacks(['שלח', 'שלח', 'שמור'], 'שלח')).toBe(false);
  });
});

describe('the list of keys whose English fell behind', () => {
  it('appends without repeating', () => {
    expect(mergeEnglishTodo(['nav.home'], 'nav.login')).toEqual(['nav.home', 'nav.login']);
    expect(mergeEnglishTodo(['nav.home'], 'nav.home')).toEqual(['nav.home']);
  });

  it('starts over on anything it cannot read, rather than throwing after the file was written', () => {
    // The save has already rewritten translations.ts by the time this runs, so a throw here reports
    // a failure for an edit that succeeded. A hand-edited `.tmp-` file is the realistic way in.
    expect(mergeEnglishTodo({}, 'nav.home')).toEqual(['nav.home']);
    expect(mergeEnglishTodo(null, 'nav.home')).toEqual(['nav.home']);
    expect(mergeEnglishTodo(['nav.home', 7, null], 'nav.login')).toEqual(['nav.home', 'nav.login']);
  });
});

describe('writing one string back into translations.ts', () => {
  const fixture = [
    'export const translations = {',
    '  he: {',
    '    // a comment holding a quote: don\'t and a { brace',
    '    nav: {',
    "      home: 'בית',",
    "      login: 'כניסה',",
    '    },',
    '  },',
    "  en: { nav: { home: 'Home', login: 'Login' } },",
    '};',
  ].join('\n');

  it('replaces the exact literal and nothing around it', () => {
    const leaves = scanLanguageBlock(fixture, 'he');
    const leaf = leaves.find((l) => l.key === 'nav.login');
    expect(leaf?.value).toBe('כניסה');

    const out = replaceLeaves(fixture, [{ leaf: leaf!, value: 'התחברות' }]);
    expect(out).toContain("login: 'התחברות'");
    // Everything else is byte-identical — the comment, the ordering, and the English block, which
    // holds the word 'Login' and must not be touched by an edit to the Hebrew.
    expect(out.replace("'התחברות'", "'כניסה'")).toBe(fixture);
  });

  it('does not confuse the two language blocks', () => {
    const english = scanLanguageBlock(fixture, 'en');
    expect(english.find((l) => l.key === 'nav.home')?.value).toBe('Home');
  });
});

describe('saving does not close the screen the sentence was on', () => {
  it('keeps the hook that abandons Vite\'s full reload', () => {
    // Writing translations.ts makes Vite reload the page, and the reload closed whatever was open:
    // an edit modal, the bulk-upload panel — so fixing three lines in one dialog meant re-opening
    // the dialog three times (owner, 2026-09-08: *"אני עושה שמור וזה מרענן וסוגר את זה וצריך לחזור
    // לפתוח את זה... סיוט"*). The editor patches the DOM itself and skips that one reload.
    //
    // Nothing else can notice if this goes: the tool still saves, still shows the right words for a
    // moment, and quietly goes back to being unusable inside a dialog. That is exactly the shape a
    // source guard is for.
    const offenders = sourceGuard({
      file: 'src/scripts/dev/copy-editor.ts',
      rule: "a vite:beforeFullReload listener throws to abandon the reload after an in-place patch",
      find: (src) =>
        /import\.meta\.hot[\s\S]{0,200}?'vite:beforeFullReload'[\s\S]{0,400}?throw new Error/.test(src)
          ? []
          : ['no vite:beforeFullReload hook that throws'],
      mustReject: `
        async function save(): Promise<void> {
          const res = await fetch('/api/dev/copy', { method: 'POST' });
          reindex(key, area.value);
          closePanel();
        }
      `,
    });
    expect(offenders).toEqual([]);
  });

  it('only ever skips ONE reload, and only just after a save', () => {
    // A blanket suppression would break every other edit on the dev server — mine to a component
    // would stop refreshing his page, which is a worse bug than the one being fixed. The window is
    // a deadline set at save time and cleared the moment it is used.
    const src = fs.readFileSync(path.join(REPO, 'src/scripts/dev/copy-editor.ts'), 'utf8');
    expect(src).toMatch(/skipReloadUntil = Date\.now\(\) \+ \d+/);
    expect(src).toMatch(/if \(Date\.now\(\) > skipReloadUntil\) return;\s*\n\s*skipReloadUntil = 0;/);
  });
});

describe('the editor\'s own chrome is not part of the page being edited', () => {
  it('takes the crosshair back off the panel and the strip', () => {
    // `body.dev-copy-armed *` is a `!important` crosshair on every element, and the panel is an
    // element (owner, 2026-09-08: *"על תיבת הטקסט עצמה של העריכה העכבר עדיין צלב"*). A crosshair
    // over a textarea says "clicking here picks a sentence", which is exactly what it does not do.
    const offenders = sourceGuard({
      file: 'src/scripts/dev/copy-editor.ts',
      rule: 'the armed crosshair is overridden inside .dev-copy-panel and .dev-copy-standing',
      find: (src) => {
        const missing: string[] = [];
        if (!/body\.dev-copy-armed \.dev-copy-panel textarea\{cursor:text/.test(src)) {
          missing.push('the textarea still shows the crosshair');
        }
        if (!/body\.dev-copy-armed \.dev-copy-standing \*\{cursor:auto/.test(src)) {
          missing.push('the standing strip still shows the crosshair');
        }
        return missing;
      },
      mustReject: 'body.dev-copy-armed *{cursor:crosshair !important}',
    });
    expect(offenders).toEqual([]);
  });

  it('gives an emptied string a way back, since the page cannot offer one', () => {
    // Empty text cannot be hovered, so once a line is deleted the panel can never be reopened on
    // it. The strip's restore row is the only route back — without it, "delete" is a one-way door
    // and the confirmation above would be an invitation to lose a string.
    const src = fs.readFileSync(path.join(REPO, 'src/scripts/dev/copy-editor.ts'), 'utf8');
    expect(src).toMatch(/kind: 'restore'; key: string; value: string/);
    expect(src).toMatch(/if \(!saved && data\.was\)/);
  });
});

describe('the strings that are drawn, not read', () => {
  /**
   * Every `translations.he.x.y` / `translations.en.x.y` a generator reads, i.e. every string whose
   * words end up baked into a committed file.
   *
   * Scanned rather than listed, because the failure this closes was silent once already: editing
   * `brand.tagline` left both lockup SVGs, their rasters, the email logo and the OG card saying the
   * old words, with a green suite — a generated image is invisible to tests
   * (`project_migration_not_applied_class`), so the moment of the edit is the only place to catch it.
   * A new generator reading a new key turns this red instead of shipping the same silence again.
   */
  function keysGeneratorsBake(): string[] {
    const dir = path.join(REPO, 'scripts');
    const found = new Set<string>();
    for (const name of fs.readdirSync(dir)) {
      if (!/^generate-.*\.mjs$/.test(name)) continue;
      const src = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const m of src.matchAll(/translations(?:\[\w+\]|\.(?:he|en))\.([\w.]+)/g)) found.add(m[1]);
    }
    return [...found].sort();
  }

  it('names a redraw command for every key a generator bakes into a committed file', () => {
    const uncovered = keysGeneratorsBake().filter((key) => !regenerateFor(key));
    expect(uncovered).toEqual([]);
  });

  it('actually finds the keys — a scan that matches nothing would pass the test above', () => {
    // The guard is a "no offenders" shape, so an empty scan is indistinguishable from a clean tree
    // (`feedback_guards_must_be_proved_to_fail`). This is the half that proves the scan runs.
    expect(keysGeneratorsBake()).toContain('brand.tagline');
  });

  it('keeps every entry pointing at a key that still exists', () => {
    // A renamed key would leave an entry that silently covers nothing — the same rot the
    // public-by-design allowlist guards against in tests/api-route-guards.test.ts.
    const gone = Object.keys(REGENERATE_AFTER).filter((key) => !(key in devCopyMap));
    expect(gone).toEqual([]);
  });

  it('says nothing for a string that is only ever read at runtime', () => {
    expect(regenerateFor('nav.home')).toBeNull();
  });
});

describe('the dictionary the editor matches against', () => {
  it('is flattened to dotted keys and covers the whole tree, arrays included', () => {
    expect(devCopyMap['nav.home']).toBeTypeOf('string');
    expect(Object.keys(devCopyMap).length).toBeGreaterThan(1000);
    expect(Object.values(devCopyMap).every((v) => typeof v === 'string')).toBe(true);
  });
});
