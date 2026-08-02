import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeHtml } from '../src/lib/html-escape.js';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, acc);
    else if (exts.some((e) => entry.name.endsWith(e))) acc.push(full);
  }
  return acc;
}

describe('escapeHtml', () => {
  it('escapes the full attribute-safe set, including both quote characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  // The bug this function exists to end: a value that closes an attribute and
  // adds an event handler. Escaping only &<> leaves it fully live.
  it('neutralizes an attribute breakout', () => {
    const payload = '" onerror="alert(1)';
    const attr = `<img src="${escapeHtml(payload)}">`;
    expect(attr).toBe('<img src="&quot; onerror=&quot;alert(1)">');
    expect(attr.match(/"/g)).toHaveLength(2); // only the two the markup itself opened/closed
  });

  it('escapes & first, so an entity is not double-encoded into a different one', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('coerces non-strings, and renders null/undefined as empty rather than as text', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(false)).toBe('false');
  });

  it('leaves ordinary text — including Hebrew and RTL marks — untouched', () => {
    expect(escapeHtml('חולצה כחולה 42')).toBe('חולצה כחולה 42');
  });

  it('is pure: no DOM, so it works in SSR frontmatter and the email builder too', () => {
    // Runs in vitest's default `node` environment — there is no `document` here.
    expect(typeof globalThis.document).toBe('undefined');
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  });
});

/**
 * The consolidation guard. Twenty local copies of this function had drifted apart
 * across the codebase, and the ones that skipped the quote character produced the
 * same stored-XSS bug three separate times (memory `project_attribute_escaping_xss`).
 * A private copy is how that drift starts, so a new one fails here.
 */
describe('nobody re-introduces a local HTML escaper', () => {
  const ALLOWED = [
    'lib/html-escape.ts',   // the one HTML implementation
    // The one XML implementation. It replaced the private copies in product-feed.ts and sitemap.ts
    // (2026-08-02) — which is why this list SHRANK: the two exemptions existed because each file
    // hand-rolled `&apos;` for itself, and they turned out not to be the same escaper at all (only
    // the feed's stripped XML-illegal control characters). One definition, one exemption.
    'lib/xml-text.ts',
  ];

  it('every escaper is the shared one', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR, ['.ts', '.astro'])) {
      const rel = file.slice(SRC_DIR.length);
      if (ALLOWED.includes(rel)) continue;
      const source = readFileSync(file, 'utf8');
      // The signature of a hand-rolled escaper: replacing the ampersand with its
      // entity. Everything legitimate now imports from html-escape.ts instead.
      if (/replace\(\/&\/g/.test(source)) offenders.push(rel);
    }
    expect(offenders, "import { escapeHtml } from 'lib/html-escape.js' instead of writing another copy").toEqual([]);
  });
});
