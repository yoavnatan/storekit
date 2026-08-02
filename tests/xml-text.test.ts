/**
 * One XML escaper, and a guard against the second one growing back.
 *
 * `product-feed.ts` and `sitemap.ts` each had a private `xmlEscape`. They looked interchangeable
 * and were not: the feed's stripped the characters XML forbids outright before escaping, the
 * sitemap's escaped five characters and stopped. That asymmetry is invisible by reading either file
 * — you have to know the other one exists — and the cost of the weaker answer is not a bad entry
 * but an unparseable DOCUMENT, so Google drops the whole feed or sitemap silently
 * (memory `project_feed_silent_rejection_class`).
 *
 * The behaviour tests below pin the rule; the source test pins the SHAPE, because a rule that has
 * already been duplicated once is the one most likely to be duplicated again — and no behaviour
 * test can see a copy that a third file makes for itself.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { xmlEscape, xmlText, xmlCdata } from '../src/lib/xml-text.js';

describe('xmlEscape', () => {
  it('escapes all five significant characters, quotes included', () => {
    // `"` and `'` matter the moment the output lands in attr="…" — the hole this codebase
    // already fixed once at escapeHtml/escH.
    expect(xmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('escapes the ampersand first, so an escape is never double-escaped', () => {
    expect(xmlEscape('a & <b>')).toBe('a &amp; &lt;b&gt;');
    expect(xmlEscape('&amp;')).toBe('&amp;amp;');
  });

  it('strips the control characters XML cannot carry even escaped', () => {
    // U+000B is the realistic one: it arrives in a description pasted out of Word or Excel.
    expect(xmlEscape('a\u000Bb')).toBe('ab');
    expect(xmlEscape('a\u0000b\u001Fc')).toBe('abc');
  });

  it('keeps tab, newline and carriage return — those are legal and meaningful', () => {
    expect(xmlEscape('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('strips an unpaired surrogate, which a title truncated mid-emoji produces', () => {
    const emoji = '🎁';
    const halved = emoji.slice(0, 1); // lone high surrogate
    expect(xmlEscape(`gift ${halved}`)).toBe('gift ');
    expect(xmlEscape(`gift ${emoji}`)).toBe(`gift ${emoji}`);
  });

  it('survives a non-string without throwing — a feed must not die on one bad field', () => {
    expect(xmlEscape(undefined as unknown as string)).toBe('');
  });
});

describe('xmlCdata', () => {
  it('splits a literal ]]> so it cannot close the section early', () => {
    expect(xmlCdata('a]]>b')).toBe('<![CDATA[a]]]]><![CDATA[>b]]>');
  });

  it('applies the SAME illegal-character strip as the escaper', () => {
    // Escaping and CDATA are two ways to carry text, not two rulesets — a field routed through
    // CDATA must not be able to smuggle in what the escaped path removes.
    expect(xmlCdata('a\u000Bb')).toBe('<![CDATA[ab]]>');
  });
});

describe('the rule has one home', () => {
  const files = ['src/lib/product-feed.ts', 'src/lib/sitemap.ts'];

  it('no XML producer defines its own escaper or illegal-character list', () => {
    for (const f of files) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf8');
      expect(src, `${f} declares a private xmlEscape`).not.toMatch(/function xmlEscape\b/);
      expect(src, `${f} declares a private XML_ILLEGAL`).not.toMatch(/const XML_ILLEGAL\b/);
    }
  });

  it('they import it instead', () => {
    for (const f of files) {
      expect(readFileSync(resolve(process.cwd(), f), 'utf8')).toContain('xml-text.js');
    }
  });
});

describe('the sitemap now gets the strip it never had', () => {
  it('is the same function the feed uses', async () => {
    const { xmlEscape: fromSitemap } = await import('../src/lib/sitemap.js');
    expect(fromSitemap).toBe(xmlEscape);
    // The regression this pins: sitemap.ts's own copy returned 'a\u000Bb' unchanged.
    expect(fromSitemap('a\u000Bb')).toBe('ab');
  });

  it('xmlText is what both escaping paths share', () => {
    expect(xmlText('a\u000Bb')).toBe('ab');
  });
});
