import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cdnSrc, cdnSrcSet, cdnBand, cdnCropSrcSet, cdnThumb, cdnFill, LIGHTBOX_WIDTHS, BANNER_WIDTHS } from '../src/lib/cdn.js';

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
  /cdnSrc|cdnSrcSet|cdnBand|cdnThumb|cdnFill|thumbUrl/,
];

describe('cdn delivery', () => {
  const CLOUD = 'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg';
  const FOREIGN = 'https://cdn.example.com/product/1.webp';

  it('injects a transform into a Cloudinary upload URL', () => {
    expect(cdnSrc(CLOUD, 300)).toBe(
      'https://res.cloudinary.com/demo/image/upload/c_limit,f_auto,q_auto,w_300/v1/photo.jpg',
    );
  });

  it('asks for a CEILING, never an upscale — `w_` alone invents pixels', () => {
    // The regression this pins (2026-08-05): a bare `w_` is `c_scale`, so every rung above the
    // seller's own resolution was delivered as an invented, softer, HEAVIER image. Measured on
    // Cloudinary's demo cloud, sample.jpg at 864x576: w_2048 → 2048x1365 / 202KB, c_limit → the
    // real 864x576 / 97KB. `c_limit` is the only crop mode here that is a cap rather than a target.
    for (const w of [...LIGHTBOX_WIDTHS, ...BANNER_WIDTHS, 400]) {
      expect(cdnSrc(CLOUD, w)).toContain('c_limit,');
    }
    // …and it must NOT leak into the two that promise an exact size to something outside the site:
    // an ad platform rejects a creative at the wrong ratio, and a favicon slot has one size.
    expect(cdnFill(CLOUD, 1200, 628)).toContain('c_fill,');
    expect(cdnFill(CLOUD, 1200, 628)).not.toContain('c_limit');
    // A fixed-size TILE still asks for exactly that size — cart/order/table cells fill a box.
    // `c_lfill` was measured to abandon the crop ratio once the box exceeds the source, which
    // costs more bytes than the upscale it avoids (see cdnThumb's header).
    expect(cdnThumb(CLOUD, 2048, 683)).toContain('c_fill,');
    expect(cdnThumb(CLOUD, 2048, 683)).not.toContain('c_lfill');
  });

  it('the banner band is a width CEILING then a ratio — never an upscale', () => {
    // The regression this pins (2026-08-05, owner: a banner whose source is narrower than 2048
    // was still served upscaled). Stating the crop as `ar_` instead of a pixel `h_` is what lets
    // the second step decline to invent pixels; `c_limit` is what stops the first one.
    // Measured on the demo cloud, sample.jpg at 864x576, asking for the 3:1 band at w_2048:
    // `c_fill,…,w_2048,h_683` → 2048x683 / 114KB, the band → 864x288 / 44KB, same picture.
    for (const w of BANNER_WIDTHS) {
      const out = cdnBand(CLOUD, w, 3);
      expect(out).toContain(`c_limit,w_${w}/`);
      expect(out).toContain('ar_3,c_fill,g_auto,f_auto,q_auto/');
      // A pixel height anywhere in the transform would be an order, not a ceiling.
      expect(out).not.toMatch(/[,/]h_\d/);
    }
    // The srcset the store page builds must be the same URLs, rung for rung.
    const set = cdnCropSrcSet(CLOUD, [...BANNER_WIDTHS], 3);
    for (const w of BANNER_WIDTHS) expect(set).toContain(`${cdnBand(CLOUD, w, 3)} ${w}w`);
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
