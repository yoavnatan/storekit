/**
 * Asks a RUNNING site whether the wordmark is being clipped, and how its
 * baseline is landing — `node scripts/measure-logo-clip.mjs <base-url> [paths…]`.
 *
 * WHY THIS EXISTS AS A TOOL AND NOT AS A TEST. The fault it looks for cannot be
 * seen in the files that cause it. On 2026-08-21 the wordmark was cut along its
 * whole bottom edge in the header, and the cause was
 * `.store-header__logo-col .logo { overflow: hidden }` — a truncation boundary
 * written for a long store NAME, in a stylesheet that says nothing about the
 * logo, inherited by an SVG that can never overflow. No diff contained it. Only
 * a rendered page shows it.
 *
 * Two numbers per page:
 *
 *   • CLIPPING ANCESTORS. Any box between the wordmark and <body> whose overflow
 *     is not `visible`. The wordmark carries its own margin inside its viewBox
 *     (generate-wordmark.mjs#BOX_MARGIN) so a clip is no longer fatal, but a clip
 *     sized exactly to the ink is still the thing that produced the fault and is
 *     worth naming.
 *
 *   • THE BOTTOM INK ROW. The wordmark's baseline is one flat line shared by all
 *     seven letters. When it lands mid-pixel the whole word gets a half-covered
 *     row, which reads as the letters being cut — the owner has reported that
 *     wording twice, in August and again here. A bounding box cannot see it: the
 *     ink is all present and correctly placed. So this measures COVERAGE of the
 *     last inked row against the row above it, at DPR 1, 2 and 3. Near 1.0 or
 *     near 0 is a clean edge; the middle is the bar.
 *
 * Run it against a built server (`npm start`), not the dev server: the dev server
 * injects CSS through JS after first paint and the measurement lands early.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';

const [base, ...paths] = process.argv.slice(2);
if (!base) {
  console.error('usage: node scripts/measure-logo-clip.mjs http://localhost:4321 [/ /stores …]');
  process.exit(2);
}
const PATHS = paths.length ? paths : ['/'];

const browser = await chromium.launch();
let bad = 0;

for (const path of PATHS) {
  for (const dpr of [1, 2, 3]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: dpr });
    await page.goto(base + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    const el = await page.$('.dz-logo svg');
    if (!el) {
      if (dpr === 1) console.log(`${path.padEnd(22)} — no wordmark on this page`);
      await page.close();
      continue;
    }

    // Passed as a STRING on purpose — the same rule generate-brand-assets.mjs
    // follows next door: the expression runs in the PAGE, not in Node, and a
    // callback here would put `document` in this file's (node-only) scope.
    const clips = await page.evaluate(`(() => {
      const out = [];
      for (let n = document.querySelector('.dz-logo'); n && n !== document.body; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.overflow !== 'visible' || cs.overflowY !== 'visible')
          out.push((n.className || n.tagName) + '(' + cs.overflow + '/' + cs.overflowY + ')');
      }
      return out;
    })()`);

    const { data, info } = await sharp(await el.screenshot())
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rows = [];
    for (let y = 0; y < info.height; y++) {
      let ink = 0;
      for (let x = 0; x < info.width; x++) ink += 255 - data[y * info.width + x];
      rows.push(ink / info.width);
    }
    const peak = Math.max(...rows);
    const last = rows.findLastIndex((r) => r > peak * 0.02);
    const ratio = rows[last] / (rows[last - 1] || 1);
    // A CLIP is a fault and fails this run. The bottom row is reported and
    // judged by eye: a flat baseline at DPR 1 is antialiased like any glyph's,
    // and only the middle of the band looks like a drawn bar rather than an
    // edge — which is a call a number should inform, not make. Compare against
    // the same page before a change rather than against a threshold.
    if (clips.length) bad++;
    const note = ratio > 0.35 && ratio < 0.75 ? '  ← look at this one' : '';
    console.log(
      `${path.padEnd(22)} dpr${dpr}  bottom-row ${ratio.toFixed(2)}${note}` +
        (clips.length ? `  CLIPPED BY ${clips.join(' ')}` : ''),
    );
    await page.close();
  }
}

await browser.close();
console.log(bad ? `\n${bad} clipped render(s) — the wordmark is inside a box that cuts it.` : '\nclean — nothing clips the wordmark.');
process.exit(bad ? 1 : 0);
