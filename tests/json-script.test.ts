import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jsonForScript } from '../src/lib/json-script.js';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, acc);
    else if (entry.name.endsWith(ext)) acc.push(full);
  }
  return acc;
}

describe('jsonForScript', () => {
  // The attack: JSON.stringify happily produces a string containing `</script>`,
  // because that is valid JSON — and the browser closes the tag on sight.
  it('makes a </script> breakout impossible', () => {
    const productName = '</script><script>alert(document.cookie)</script>';
    const blob = jsonForScript({ name: productName });
    expect(blob).not.toContain('</script');
    expect(blob).not.toContain('<');
    expect(JSON.stringify({ name: productName })).toContain('</script>'); // what we're replacing
  });

  it('stays valid JSON — the escapes decode back to the original value', () => {
    const value = { name: '</script>', desc: 'a & b', tag: '<b>' };
    expect(JSON.parse(jsonForScript(value))).toEqual(value);
  });

  it('escapes the ampersand too, so an entity-decoding context cannot rebuild `<`', () => {
    expect(jsonForScript('&lt;')).not.toContain('&');
  });

  // Valid in JSON, but a raw line terminator inside a JS string literal — it would
  // break BaseLayout's dataLayer push, which interpolates the blob into real JS.
  // Written as escape sequences: literal U+2028 in a source file ends the line.
  it('escapes U+2028/U+2029', () => {
    const value = { a: '\u2028', b: '\u2029' };
    const blob = jsonForScript(value);
    expect(blob).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.parse(blob)).toEqual(value);
  });

  it('handles null/undefined without emitting the literal "undefined" (invalid JSON)', () => {
    expect(jsonForScript(undefined)).toBe('null');
    expect(jsonForScript(null)).toBe('null');
    expect(() => JSON.parse(jsonForScript(undefined))).not.toThrow();
  });
});

/**
 * The guard. Before 2026-07-29 this sink appeared 15 times: 4 hand-escaped, 11 raw
 * — including the JSON-LD on every public page, the store/product page search blob
 * and the dataLayer push, all of which carry seller-supplied product names to any
 * visitor. Escaping per-site is how eleven of them got missed, so the rule is
 * mechanical instead.
 */
describe('nothing embeds raw JSON.stringify in a <script>', () => {
  it('every set:html blob goes through jsonForScript', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR, '.astro')) {
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        // `set:html={JSON.stringify(...)` — including the multi-line form, where the
        // opening paren is the last thing on the line.
        if (/set:html=\{[^}]*JSON\.stringify/.test(line)) {
          offenders.push(`${file.slice(SRC_DIR.length)}:${i + 1}`);
        }
      });
    }
    expect(offenders, 'use jsonForScript() from lib/json-script.ts — JSON.stringify does not escape </script>').toEqual([]);
  });

  it('nobody hand-rolls the escape either', () => {
    const offenders: string[] = [];
    for (const file of [...walk(SRC_DIR, '.astro'), ...walk(SRC_DIR, '.ts')]) {
      if (file.endsWith('lib/json-script.ts')) continue;
      const source = readFileSync(file, 'utf8');
      if (/\\\\u003c/.test(source)) offenders.push(file.slice(SRC_DIR.length));
    }
    expect(offenders, 'partial hand-rolled escapes are how this drifted — call jsonForScript()').toEqual([]);
  });
});
