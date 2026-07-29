import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cdnSrc, cdnSrcSet, cdnThumb, cdnFill } from '../src/lib/cdn.js';

/**
 * The image-performance guard.
 *
 * Standing user instruction (2026-07-28): images must optimize themselves, and
 * the rule must not need re-stating every time somebody adds an <img> somewhere
 * new. It kept regressing per-surface — a raw seller/demo URL painted into a
 * 36px cell, or a hand-rolled lazy-loader that hid the URL from the browser's
 * preload scanner. So the rule lives here, mechanically, instead of in a habit:
 *
 *   1. Every image URL goes through src/lib/cdn.ts (cdnSrc/cdnSrcSet/cdnThumb/
 *      cdnFill) — nothing hands a raw remote URL to an <img>.
 *   2. Every <img> declares `loading` and `decoding`.
 *   3. Nobody hand-rolls lazy-loading with an IntersectionObserver + a stashed
 *      URL attribute. Native `loading="lazy"` does it without blocking the
 *      visible images behind JS. (Deferring an OFF-SCREEN image inside an
 *      already-open modal/carousel via data-src is fine and is allowlisted by
 *      name below — what's banned is the attribute pair that hid a whole page's
 *      images from the preload scanner.)
 *
 * When this fails, fix the markup — do not add to the allowlists without a
 * reason written next to the entry.
 */

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, acc);
    else if (exts.some((e) => entry.name.endsWith(e))) acc.push(full);
  }
  return acc;
}

const rel = (p: string) => p.slice(SRC_DIR.length);

/** Blanks out comments while preserving line numbering, so prose describing an
 *  `<img src>` isn't scanned as markup (it has tripped this twice). Only whole
 *  comment lines and `/* *\/` blocks — never a mid-line `//`, which would eat
 *  the `//` in a URL. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line))
    .join('\n');
}

/** Every `<img ...>` tag in the file, with the line it starts on. */
function imgTags(rawSource: string): { tag: string; line: number }[] {
  const source = stripComments(rawSource);
  const out: { tag: string; line: number }[] = [];
  // `<img\s` (not bare `<img`) so prose in a comment — "an <img> with no src" —
  // isn't scanned as markup. A real tag always has at least one attribute.
  const re = /<img\s[\s\S]*?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    out.push({ tag: m[0], line: source.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** src values that legitimately never touch the CDN. */
const SRC_ALLOWED = [
  /^src=("|')?\{?BLANK_PIXEL/,                 // inline 1x1 placeholder, no request
  /^src=("|')?\{?["'`]?\s*["'`]?$/,            // empty src, filled by JS (checked at the assignment)
  /^src="https:\/\/www\.facebook\.com\/tr\?/,  // Meta pixel beacon, not an image
  /^src="\/[^"]*\.(svg|png|webp|avif|jpg)"/,   // static asset shipped in /public
  /cdnSrc|cdnSrcSet|cdnThumb|cdnFill|thumbUrl/,
];

describe('cdn delivery', () => {
  const CLOUD = 'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg';
  const FOREIGN = 'https://cdn.example.com/product/1.webp';

  it('injects a transform into a Cloudinary upload URL', () => {
    expect(cdnSrc(CLOUD, 300)).toBe(
      'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_300/v1/photo.jpg',
    );
  });

  it('leaves an already-transformed URL alone rather than stacking transforms', () => {
    const once = cdnSrc(CLOUD, 300);
    expect(cdnSrc(once, 600)).toBe(once);
  });

  it('passes through what it cannot improve: relative paths, data URIs, dev hosts', () => {
    expect(cdnSrc('/logo.png')).toBe('/logo.png');
    expect(cdnSrc('data:image/gif;base64,R0lGOD')).toBe('data:image/gif;base64,R0lGOD');
    expect(cdnSrc('http://localhost:4321/uploads/a.png')).toBe('http://localhost:4321/uploads/a.png');
    expect(cdnSrc('')).toBe('');
  });

  it('never throws on a malformed URL', () => {
    expect(() => cdnSrc('http://[bad')).not.toThrow();
  });

  // The remaining behaviour depends on a configured cloud (PUBLIC_CLOUDINARY_CLOUD_NAME).
  // Without one every helper must degrade to a working passthrough, never to a broken URL.
  const cloudConfigured = cdnSrc(FOREIGN, 300) !== FOREIGN;

  it('routes a foreign host through fetch delivery — resized, re-formatted, cacheable', () => {
    if (!cloudConfigured) {
      expect(cdnSrc(FOREIGN, 300)).toBe(FOREIGN);
      return;
    }
    const out = cdnSrc(FOREIGN, 300);
    expect(out).toMatch(/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/fetch\/f_auto,q_auto,w_300\//);
    // The origin URL must be encoded, or a query string in it would be read as
    // part of Cloudinary's own path.
    expect(out.endsWith(encodeURIComponent(FOREIGN))).toBe(true);
  });

  it('builds a multi-width srcset for a foreign host too (that was the regression)', () => {
    const set = cdnSrcSet(FOREIGN, [220, 440]);
    if (!cloudConfigured) {
      expect(set).toBe('');
      return;
    }
    expect(set.split(', ')).toHaveLength(2);
    expect(set).toContain('220w');
    expect(set).toContain('440w');
  });

  it('crops thumbnails to exact dimensions and forces a format for off-site consumers', () => {
    expect(cdnThumb(CLOUD, 72, 72)).toContain('c_fill,g_auto,f_auto,q_auto,w_72,h_72');
    expect(cdnFill(CLOUD, 1200, 630)).toContain('c_fill,g_auto,f_jpg,q_auto,w_1200,h_630');
    // cdnFill promises exact dimensions or nothing at all — callers fall back to a
    // generated mark rather than hand an ad platform an unknown aspect ratio.
    expect(cdnFill('/local.png', 1200, 630)).toBe('');
  });
});

describe('no <img> bypasses the CDN helpers', () => {
  const files = [...walk(SRC_DIR, ['.astro']), ...walk(SRC_DIR, ['.ts'])]
    .filter((f) => !f.includes('/lib/email/')); // email HTML is inlined for mail clients, checked separately

  it('every img src runs through src/lib/cdn.ts', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const { tag, line } of imgTags(source)) {
        const m = tag.match(/\ssrc=(\{[^}]*\}|"[^"]*"|'[^']*')/);
        if (!m) continue; // no src at all — covered by the JS-assignment rule
        const src = `src=${m[1]}`;
        if (!SRC_ALLOWED.some((re) => re.test(src))) {
          offenders.push(`${rel(file)}:${line} → ${src.slice(0, 80)}`);
        }
      }
    }
    expect(offenders, 'raw image URL handed to an <img> — wrap it in cdnSrc/cdnThumb (src/lib/cdn.ts)').toEqual([]);
  });

  it('every img declares loading + decoding', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const { tag, line } of imgTags(source)) {
        const m = tag.match(/\ssrc=("[^"]*")/);
        if (m && /facebook\.com\/tr\?/.test(m[1])) continue; // tracking beacon, not an image
        const missing = ['loading', 'decoding'].filter((a) => !new RegExp(`\\s${a}=`).test(tag));
        if (missing.length) offenders.push(`${rel(file)}:${line} → missing ${missing.join(' + ')}`);
      }
    }
    expect(offenders, 'every <img> needs loading + decoding (Lighthouse: proper alt/width/height/lazy)').toEqual([]);
  });

  it('nobody re-introduces a JS lazy-loader that hides images from the preload scanner', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // The attribute itself, not the phrase — the components that were converted
      // away from it still explain in a comment why it's gone.
      if (/data-lazy-src=|dataset\.lazySrc/.test(source)) offenders.push(rel(file));
    }
    expect(offenders, 'use native loading="lazy" — an <img> with no src cannot be preload-scanned').toEqual([]);
  });
});
