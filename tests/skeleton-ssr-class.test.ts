/**
 * The skeleton shimmer class is never server-rendered onto a wrap whose image can paint on
 * its own.
 *
 * **Why this is a test and not a comment.** The shimmer sits UNDER the image (putting it on
 * top held cached photos invisible for ~700ms — store-card.css has that measurement), which
 * is right for a photograph and wrong for a background-removed one: a transparent PNG shows
 * whatever is behind it, so a shimmer still running behind a fully-painted product is
 * visible straight through the subject. The owner reported this thing three separate times,
 * against three different attempted fixes, and it is the SSR class that keeps bringing it
 * back — rendered server-side, it animates from first paint until the page bundle has
 * downloaded, parsed and run, while the image (cached, eager, or just small) paints long
 * before that. Measured 2026-08-04 with a probe installed ahead of any page script: 96 of 97
 * homepage tiles shimmering over an already-painted image, up to 726ms, up to 3.9s at 4x CPU
 * throttle.
 *
 * The rule: markup may say "this box CAN shimmer" (`data-skeleton`, inert), never "this box
 * IS shimmering". Only lib/img-skeleton.ts, at runtime, can know whether a fetch is in
 * flight — and that is the only thing entitled to add the class.
 *
 * The exception, which is the whole reason this scans images rather than banning the string:
 * a wrap whose `<img>` carries no `src` at all, only `data-src` fetched later by its own
 * code (the product page's sticky mini-bar, the quick-view modal's slides). Nothing can
 * paint there until JS acts, so `is-loading` in that markup states something true.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(astro|ts)$/.test(e.name) && !full.includes(`${path.sep}styles${path.sep}`) ? [full] : [];
  });
}

/** The element (opening tag onwards) that carries `is-loading`, up to a sane cutoff. */
function tagsWithLoadingClass(text: string): { line: number; snippet: string }[] {
  const out: { line: number; snippet: string }[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    // Only markup: a class list, not `classList.remove('is-loading')` or a comment.
    if (!/class\s*=|class\s*=\{|class="/.test(line)) return;
    if (!/is-loading/.test(line)) return;
    if (/classList\.(add|remove|contains|toggle)/.test(line)) return;
    // The wrap's <img> may be on a following line — take a window.
    out.push({ line: i + 1, snippet: lines.slice(i, i + 6).join('\n') });
  });
  return out;
}

/** Does this element's image paint without JS — i.e. does it have a real `src`? */
function imageCanPaintWithoutJs(snippet: string): boolean {
  const hasRealSrc = /<img[^>]*\ssrc=/.test(snippet) || /<Image\b/.test(snippet);
  const deferredOnly = /data-src=/.test(snippet) && !/<img[^>]*\ssrc=/.test(snippet);
  return hasRealSrc && !deferredOnly;
}

interface Offence { file: string; line: number }

function findOffences(): Offence[] {
  const out: Offence[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { line, snippet } of tagsWithLoadingClass(text)) {
      if (imageCanPaintWithoutJs(snippet)) out.push({ file: path.relative(process.cwd(), file), line });
    }
  }
  return out;
}

describe('the shimmer class is never rendered onto an image that can paint on its own', () => {
  it('finds no server-rendered is-loading over a real src', () => {
    const offences = findOffences();
    expect(
      offences,
      offences.length
        ? `These render 'is-loading' in markup on a wrap whose image has a real src, so the shimmer\n` +
          `runs behind an already-painted photo until the page bundle executes — and shows straight\n` +
          `through any background-removed product image. Render the inert 'data-skeleton' marker\n` +
          `instead and let lib/img-skeleton.ts add the class when a fetch is actually in flight:\n${offences
            .map((o) => `  ${o.file}:${o.line}`)
            .join('\n')}`
        : '',
    ).toEqual([]);
  });

  it('actually looks at the files, and both halves of its matcher work', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(50);
    // The marker is really in use — a guard that passed because nothing renders a shimmer
    // at all would be worthless the day someone adds one back.
    const home = fs.readFileSync(path.join(SRC, 'components/HomeProductCard.astro'), 'utf8');
    expect(home).toContain('data-skeleton');

    // The forbidden shape is recognised…
    const bad = `<div class="wrap is-loading">\n<img src="/a.jpg" />`;
    expect(tagsWithLoadingClass(bad)).toHaveLength(1);
    expect(imageCanPaintWithoutJs(bad)).toBe(true);

    // …and the deferred-image exception is not.
    const deferred = `<span id="sticky-mini-img-wrap" class="is-loading">\n<img data-src="/a.jpg" />`;
    expect(imageCanPaintWithoutJs(deferred)).toBe(false);

    // A JS call that merely mentions the class is not markup.
    expect(tagsWithLoadingClass(`wrap.classList.add('is-loading'); // class=`)).toHaveLength(0);
  });
});
