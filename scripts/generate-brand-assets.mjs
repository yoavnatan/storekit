/**
 * Renders the brand lockup to PNG — `npm run brand:assets`.
 *
 * Two surfaces cannot use the SVG logo the site itself uses:
 *   • EMAIL. Mail clients don't render SVG, and several strip <style> entirely,
 *     so the header of every order mail needs a raster image on a public URL.
 *   • SHARE CARDS. `og:image` is fetched by scrapers (WhatsApp, Facebook,
 *     iMessage, X) that accept PNG/JPEG only. `store.config.ts` has pointed at
 *     /og-default.png since before this script existed — the file simply never
 *     existed, so sharing the homepage produced a card with no image at all.
 *
 * The rasteriser is Playwright, which is already a devDependency (it is what the
 * layout-shift and alignment measurements run on). That matters: the alternative
 * is a font rasteriser in the app's own dependencies, for output that changes
 * about once a year. This runs by hand, its output is committed, and nothing at
 * runtime depends on it.
 *
 * The geometry is NOT re-typed here. The `D` path and every spacing value are
 * read out of `src/components/BrandLogo.astro` at generation time, so a change
 * to the component can never leave a stale logo in people's inboxes.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'public');
const FONTS = resolve(ROOT, 'node_modules/@fontsource');

/** The site's brand gradient — the one `.btn` wears. Kept in one place here too. */
const BRAND_A = '#2a3c40';
const BRAND_B = '#3a5260';
/** The D's slice of that ramp: it covers the first 16.7% of the wordmark. */
const D_SLICE_END = '#2d4045';

const b64 = (p) => readFileSync(p).toString('base64');

/** Pull the drawn D straight out of the component, so the two cannot drift. */
function readMarkPath() {
  const src = readFileSync(resolve(ROOT, 'src/components/BrandLogo.astro'), 'utf8');
  const d = src.match(/\n\s*d="([^"]+)"/)?.[1];
  if (!d) throw new Error('BrandLogo.astro: could not find the D path — did the markup change?');
  return d.replace(/\s+/g, ' ').trim();
}

/**
 * One lockup, as HTML. Every number here is the same one the component uses:
 * tracking −0.03em on the name, −0.015em between the D and the e (Heebo's own
 * "De" ink gap), and a tagline that lands at exactly the name's width because of
 * its SIZE — Heebo 500 at 0.39em, at the font's own spacing. It used to be Rubik
 * stretched with tracking to the same width; see BrandLogo.astro for why both
 * halves of that changed.
 */
function page({ path, size, tone, tagline, background }) {
  const heeboLatin = b64(`${FONTS}/heebo/files/heebo-latin-700-normal.woff2`);
  const heeboHebrew = b64(`${FONTS}/heebo/files/heebo-hebrew-500-normal.woff2`);
  const ink = tone === 'white' ? '#fff' : `url(#g)`;
  const textFill =
    tone === 'white'
      ? 'color:#fff'
      : `background-image:linear-gradient(135deg,${BRAND_A},${BRAND_B});-webkit-background-clip:text;background-clip:text;color:transparent`;
  return `<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:'Heebo';src:url(data:font/woff2;base64,${heeboLatin}) format('woff2');font-weight:700;}
    @font-face{font-family:'Heebo';src:url(data:font/woff2;base64,${heeboHebrew}) format('woff2');font-weight:500;}
    html,body{margin:0;height:100%}
    body{background:${background};display:flex;align-items:center;justify-content:center}
    .logo{display:inline-flex;flex-direction:column;align-items:flex-start;gap:.05em;font-size:${size}px}
    .word{direction:ltr;display:flex;align-items:baseline;font-family:'Heebo';font-weight:700;
          line-height:1;letter-spacing:-.03em;${textFill}}
    .word svg{height:.71em;width:auto;flex:none;display:block;margin-inline-end:-.015em}
    .tag{font-family:'Heebo';font-weight:500;font-size:.39em;line-height:1;direction:rtl;
         color:${tone === 'white' ? '#fff' : BRAND_A}}
  </style>
  <div class="logo">
    <div class="word">
      <svg viewBox="10.75 8 23 28"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${BRAND_A}"/><stop offset="1" stop-color="${D_SLICE_END}"/>
      </linearGradient></defs><path fill="${ink}" fill-rule="evenodd" d="${path}"/></svg><span>ezabin</span>
    </div>
    ${tagline ? '<div class="tag">מתחם חנויות דיגיטלי</div>' : ''}
  </div>`;
}

/** The favicon tile, at the sizes iOS and Android ask for. */
function tilePage({ path, px }) {
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}
    svg{display:block}</style>
  <svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 44 44">
    <defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND_A}"/><stop offset="1" stop-color="${BRAND_B}"/></linearGradient></defs>
    <rect width="44" height="44" fill="url(#t)"/>
    <path fill="#fff" fill-rule="evenodd" d="${path}"/>
  </svg>`;
}

const path = readMarkPath();
const browser = await chromium.launch();

async function shot(html, { width, height, scale = 1, file, transparent = false, quality }) {
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await p.setContent(html);
  // Passed as a STRING on purpose: the expression runs in the page, not in Node,
  // and a callback here would put `document` in this file's (node-only) scope.
  // Waiting for it is not optional — screenshotting before the faces resolve
  // rasterises a fallback serif, which is exactly the mistake that produced a
  // wrong measurement earlier in this task.
  // `fonts.status` alone is not enough — it reads "loaded" before anything has
  // been asked for. Ask about the two faces by name instead.
  await p.waitForFunction(
    'document.fonts.check("700 34px Heebo") && document.fonts.check("500 12px Heebo", "ק")',
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    await p.screenshot({
      omitBackground: transparent,
      ...(quality ? { type: 'jpeg', quality } : {}),
    }),
  );
  await p.close();
  const px = `${width * scale}×${height * scale}`;
  console.log(`  ${file.replace(ROOT + '/', '')}  ${px}`);
}

console.log('brand assets:');

// Email header. Rendered at 2× and declared at half size in the template so it
// stays sharp on the retina screens most mail is read on, and drawn as WHITE INK
// ON A SOLID PLATE the exact colour of the mail's header bar — not transparent.
// Alpha is the one thing old Outlook still gets wrong, and an opaque plate whose
// colour matches the bar is invisible either way.
await shot(page({ path, size: 34, tone: 'white', tagline: true, background: BRAND_A }),
  { width: 260, height: 74, scale: 2, file: `${OUT}/logo-email.png` });

// Share card. 1200×630 is what Facebook/WhatsApp/X crop to; the lockup sits on
// the brand gradient so the card is recognisable as this site at thumbnail size.
//
// JPEG, not PNG, and the reason is not file hygiene: WhatsApp drops the preview
// image entirely above roughly 300KB, and a full-bleed gradient is the worst
// case for PNG — it dithers into a quarter of a megabyte. At q92 this is a fifth
// of that with no visible artefact on flat colour and white type.
await shot(page({
    path, size: 96, tone: 'white', tagline: true,
    background: `linear-gradient(135deg,${BRAND_A},${BRAND_B})`,
  }), { width: 1200, height: 630, quality: 92, file: `${OUT}/og-default.jpg` });

// Home-screen icon. iOS ignores SVG favicons and falls back to a screenshot
// without this file.
await shot(tilePage({ path, px: 180 }), { width: 180, height: 180, file: `${OUT}/apple-touch-icon.png` });

await browser.close();
