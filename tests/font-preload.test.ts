import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY `@font-face` DECLARED IN main.css MUST BE PRELOADED IN BaseLayout.astro.
 *
 * This site sets `font-display: optional` on every face, deliberately: `swap` repainted the text in
 * the fallback font and visibly reflowed on every navigation, warm cache included (measured with
 * Playwright's layout-shift observer, 2026-07-16). `optional` buys that away with one condition —
 * the browser only uses a face that is *already available* at first paint. A preload is what makes
 * it available. A face without one is a face the browser is free to refuse, silently, forever.
 *
 * That is not a hypothetical: it is how the brand lockup shipped misaligned. A single Rubik face
 * carried the Hebrew line under the wordmark with no preload of its own, got refused at first
 * paint, fell back to Heebo at different metrics, and the three values that positioned the drawn
 * underline — solved against Rubik — were wrong for what actually rendered. Nothing errored. It
 * just looked slightly broken, on the one element that appears on every page.
 *
 * The response then was the blunt one: Heebo became the only family on the site. That rule was
 * narrowed on 2026-08-09 so a store's own name could take a display face (Noto Serif Hebrew), and
 * this test is the condition on which it was narrowed — see the long note in main.css. It is the
 * reason a third family can be argued for at all, and the reason none can be added carelessly.
 *
 * Both sides are matched on the woff2 FILENAME rather than on the family name: BaseLayout imports
 * the files through Vite (`?url`) so it never mentions a family, and main.css never mentions the
 * hashed output path. The filename is the one token both sides genuinely share.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/** `heebo-hebrew-800-normal.woff2` → the basename, which is what both files agree on. */
const basename = (url: string) => url.split('/').pop()!.replace(/[?#].*$/, '');

describe('font-face / preload parity', () => {
  const css = read('src/styles/main.css');
  const layout = read('src/layouts/BaseLayout.astro');

  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
    const block = m[1];
    const family = /font-family:\s*['"]([^'"]+)['"]/.exec(block)?.[1] ?? '(unnamed)';
    const src = /src:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(block)?.[1] ?? '';
    const display = /font-display:\s*([\w-]+)/.exec(block)?.[1] ?? '(unset)';
    return { family, file: basename(src), display };
  });

  // Only the URLs that are actually rendered as <link rel="preload">, which in this layout means
  // the identifiers listed in the preload array — an unused import would otherwise pass this test
  // while preloading nothing.
  const preloadArray = /\{\[([^\]]*?)\]\.map\(\(href\) => \(\s*<link rel="preload"/s.exec(layout)?.[1] ?? '';
  const preloadedIdents = new Set(
    preloadArray.split(',').map((s) => s.trim()).filter(Boolean),
  );
  const importedFiles = new Map(
    [...layout.matchAll(/import\s+(\w+)\s+from\s+'([^']+\.woff2)\?url'/g)].map((m) => [m[1], basename(m[2])]),
  );
  const preloadedFiles = new Set(
    [...preloadedIdents].map((id) => importedFiles.get(id)).filter(Boolean) as string[],
  );

  it('finds the faces and the preload list at all (guards against this test silently passing)', () => {
    expect(faces.length).toBeGreaterThan(0);
    expect(preloadedFiles.size).toBeGreaterThan(0);
  });

  it.each(faces)('$family — $file is preloaded', ({ file }) => {
    expect(preloadedFiles.has(file)).toBe(true);
  });

  it('preloads nothing it does not declare — a preload for a dropped face is dead weight on every page', () => {
    const declared = new Set(faces.map((f) => f.file));
    expect([...preloadedFiles].filter((f) => !declared.has(f))).toEqual([]);
  });

  it('keeps every face on font-display: optional — the whole reason the preload is mandatory', () => {
    expect(faces.filter((f) => f.display !== 'optional')).toEqual([]);
  });
});

/**
 * NOTHING MAY ASK FOR A WEIGHT THE FACE DOES NOT HAVE.
 *
 * The site ran on Heebo until 2026-08-23, which shipped 100–900 as ten separate static
 * cuts: a weight was either declared or it was not, and a missing one was visible. The
 * face is VARIABLE now, which declares a RANGE — and a variable range does not fail an
 * out-of-range request, CSS font matching CLAMPS it. Ask a 400–700 family for 800 and it
 * paints exactly 700 while the stylesheet still says 800, and nothing anywhere reports
 * it: not the browser, not the build, not a screenshot diff, because 700 is a perfectly
 * reasonable-looking weight. Same shape as the `font-display: optional` trap above — a
 * rule that plainly did not do what it said, on a page that looked fine.
 *
 * This is not hypothetical. Google Sans was the pick for about an hour that same day and
 * stops at 700; the twenty rules that sit at 800 here (prices, stat numbers, the header's
 * store name) were all rewritten to 700 for it, and all restored when the pick moved to
 * Noto Sans Hebrew, which covers 100–900. The next family will not necessarily.
 *
 * The bounds are read from main.css rather than typed, so a swap moves this test with it
 * instead of leaving a stale pair of numbers behind.
 */
describe('font-weight range', () => {
  const css = read('src/styles/main.css');

  /** `font-weight: 100 900` in a variable @font-face — the range the site actually ships. */
  const range = /@font-face[^}]*font-weight:\s*(\d{3})\s+(\d{3})/.exec(css);
  const [min, max] = range ? [Number(range[1]), Number(range[2])] : [400, 700];

  /** Tailwind's named weights, which are as much a declaration as a CSS number is. */
  const NAMED: Record<string, number> = {
    thin: 100, extralight: 200, light: 300, normal: 400,
    medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900,
  };

  const files: string[] = [];
  (function walk(dir: string): void {
    for (const e of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(css|astro|ts|tsx|js|mjs|html)$/.test(e.name)) files.push(rel);
    }
  })('src');

  const offenders: string[] = [];
  for (const rel of files) {
    const text = read(rel);
    for (const m of text.matchAll(/font-weight\s*[:=]\s*["']?(\d{3})\b/g)) {
      const w = Number(m[1]);
      if (w < min || w > max) offenders.push(`${rel}: font-weight ${w}`);
    }
    for (const m of text.matchAll(/\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g)) {
      const w = NAMED[m[1]];
      if (w < min || w > max) offenders.push(`${rel}: font-${m[1]} (${w})`);
    }
    for (const m of text.matchAll(/\bfont-\[(\d{3})\]/g)) {
      const w = Number(m[1]);
      if (w < min || w > max) offenders.push(`${rel}: font-[${w}]`);
    }
  }

  it('reads the shipped range off the @font-face rules (guards against this test going blind)', () => {
    expect(range, 'no variable font-weight range found in main.css').not.toBeNull();
    expect(files.length).toBeGreaterThan(50);
  });

  it("asks for nothing outside the face's own range", () => {
    expect(offenders).toEqual([]);
  });
});
