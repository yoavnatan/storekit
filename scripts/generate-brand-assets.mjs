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
 * The geometry is NOT re-typed here. Every path and every spacing value comes
 * from `src/lib/brand-lockup.ts` — the same module the component and the favicon
 * read — so a change to the lockup can never leave a stale logo in people's
 * inboxes. Node imports that `.ts` directly (type stripping, ≥22.18); it holds
 * only `export const`s, so there is nothing to compile.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { chromium } from 'playwright';
import {
  MARK_PATH,
  LETTERS_PATH,
  VIEW_BOX,
  MARK_VIEW_BOX,
  HEIGHT_EM,
  GRADIENT,
  TAGLINE,
} from '../src/lib/brand-lockup.ts';
// The words come from the dictionary the site itself renders, never a copy —
// see the same note in generate-wordmark.mjs.
import { translations } from '../src/i18n/translations.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'public');
const FONTS = resolve(ROOT, 'node_modules/@fontsource');

/** The site's brand gradient — the one `.btn` wears. Kept in one place here too. */
const BRAND_A = '#2a3c40';
const BRAND_B = '#3a5260';
/** The mark's own box — its viewBox is cropped to the stroked ink, so these two
 *  ARE the letter, and the tile below re-centres itself when it is redrawn. */
const [MARK_X, MARK_Y, MARK_W, MARK_H] = MARK_VIEW_BOX.split(' ').map(Number);

const b64 = (p) => readFileSync(p).toString('base64');

/**
 * One lockup, as HTML.
 *
 * NOTHING GEOMETRIC IS TYPED HERE ANY MORE (2026-08-10). This function used to
 * re-type five numbers the component also carried — the tracking, the D→e
 * margin, the tagline's size and margin — and its own comment admitted that was
 * the one thing it could not check for you. It now draws the same paths from
 * `src/lib/brand-lockup.ts` that the component draws, so a stale mail header is
 * no longer possible: there is one drawing, and this only decides how big and on
 * what ground. The only face still needed is Heebo, for the Hebrew line.
 */
function page({ size, tone, tagline, background, lang = 'he' }) {
  const w = TAGLINE.weight;
  const heeboHebrew = b64(`${FONTS}/heebo/files/heebo-hebrew-${w}-normal.woff2`);
  const heeboLatin = b64(`${FONTS}/heebo/files/heebo-latin-${w}-normal.woff2`);
  const paint = tone === 'white' ? '#fff' : 'url(#g)';
  const isHe = lang === 'he';
  const track = isHe ? TAGLINE.trackEm.he : TAGLINE.trackEm.en;
  return `<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:'Heebo';src:url(data:font/woff2;base64,${heeboHebrew}) format('woff2');font-weight:${w};unicode-range:U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F;}
    @font-face{font-family:'Heebo';src:url(data:font/woff2;base64,${heeboLatin}) format('woff2');font-weight:${w};}
    html,body{margin:0;height:100%}
    body{background:${background};display:flex;align-items:center;justify-content:center}
    .logo{display:inline-flex;flex-direction:column;align-items:center;row-gap:${TAGLINE.gapEm}em;font-size:${size}px}
    .logo svg{height:${HEIGHT_EM}em;width:auto;flex:none;display:block;max-width:none}
    /* The negative end margin is the trailing letter-space taken back: without
       it the centred line sits half a tracking unit off its own axis. Same fix,
       same reason, as in BrandLogo.astro. */
    .tag{font-family:'Heebo';font-weight:${w};font-size:${TAGLINE.sizeEm}em;line-height:1;
         direction:${isHe ? 'rtl' : 'ltr'};letter-spacing:${track}em;margin-inline-end:${-track}em;
         white-space:nowrap;color:${tone === 'white' ? '#fff' : BRAND_A}}
  </style>
  <div class="logo">
    <svg viewBox="${VIEW_BOX}">
      <defs><linearGradient id="g" gradientUnits="userSpaceOnUse"
        x1="${GRADIENT.x1}" y1="${GRADIENT.y1}" x2="${GRADIENT.x2}" y2="${GRADIENT.y2}">
        <stop offset="0" stop-color="${GRADIENT.from}"/><stop offset="1" stop-color="${GRADIENT.to}"/>
      </linearGradient></defs>
      <g fill="${paint}">
        <path d="${MARK_PATH}"/><path d="${LETTERS_PATH}"/>
      </g>
    </svg>
    ${tagline ? `<div class="tag">${translations[lang].brand.tagline}</div>` : ''}
  </div>`;
}

/** The favicon tile, at the sizes iOS and Android ask for.
 *
 *  The letter is centred by arithmetic, not by eye, and that is not a tweak: it
 *  was exactly centred once only because the 700 Heebo drawing happened to be
 *  21.5 wide in a 44 tile, and a redraw silently broke it. Off by even 1% of the
 *  tile is visible on a home screen, where the icon is the only thing in its
 *  box. Both terms come from the module, so a new D re-centres itself. */
function tilePage({ px }) {
  const TILE = 44;
  const scale = (TILE * 0.52) / MARK_H; // the mark occupies 52% of the tile's height
  const w = MARK_W * scale;
  const h = MARK_H * scale;
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}
    svg{display:block}</style>
  <svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${TILE} ${TILE}">
    <defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND_A}"/><stop offset="1" stop-color="${BRAND_B}"/></linearGradient></defs>
    <rect width="${TILE}" height="${TILE}" fill="url(#t)"/>
    <g transform="translate(${((TILE - w) / 2 - MARK_X * scale).toFixed(3)} ${((TILE - h) / 2 - MARK_Y * scale).toFixed(3)}) scale(${scale.toFixed(5)})">
      <path fill="#fff" d="${MARK_PATH}"/>
    </g>
  </svg>`;
}
const browser = await chromium.launch();

async function shot(html, { width, height, scale = 1, file, transparent = false, quality }) {
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await p.setContent(html);
  // Passed as a STRING on purpose: the expression runs in the page, not in Node,
  // and a callback here would put `document` in this file's (node-only) scope.
  //
  // Only the Hebrew line is text now — the wordmark is paths and cannot be
  // waiting on anything — but this wait is still not optional: screenshotting
  // before the face resolves rasterises a fallback, which is exactly the mistake
  // that produced a wrong measurement in August. `fonts.status` alone is not
  // enough; it reads "loaded" before anything has been asked for, so ask about
  // the face by name.
  await p.waitForFunction(`document.fonts.check("${TAGLINE.weight} 12px Heebo", "ק")`);
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
await shot(page({ size: 34, tone: 'white', tagline: true, background: BRAND_A }),
  { width: 260, height: 74, scale: 2, file: `${OUT}/logo-email.png` });

// Share card. 1200×630 is what Facebook/WhatsApp/X crop to; the lockup sits on
// the brand gradient so the card is recognisable as this site at thumbnail size.
//
// JPEG, not PNG, and the reason is not file hygiene: WhatsApp drops the preview
// image entirely above roughly 300KB, and a full-bleed gradient is the worst
// case for PNG — it dithers into a quarter of a megabyte. At q92 this is a fifth
// of that with no visible artefact on flat colour and white type.
await shot(page({
    size: 96, tone: 'white', tagline: true,
    background: `linear-gradient(135deg,${BRAND_A},${BRAND_B})`,
  }), { width: 1200, height: 630, quality: 92, file: `${OUT}/og-default.jpg` });

// Home-screen icon. iOS ignores SVG favicons and falls back to a screenshot
// without this file.
await shot(tilePage({ px: 180 }), { width: 180, height: 180, file: `${OUT}/apple-touch-icon.png` });

await browser.close();
