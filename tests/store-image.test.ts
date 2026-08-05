import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OG_IMAGE_FORMAT,
  ROUND_ICON_FORMATS,
  STORE_ICON_FORMATS,
  STORE_IMAGE_FORMATS,
  STORE_RENDER_FORMATS,
  isStoreRenderFormat,
  pairedImageSource,
  parseStoreImageFile,
  resolveStoreImage,
  storeAdCreative,
  storeIconUrl,
  storeImageUrl,
  storeMarkPath,
  type StoreIconFormat,
  type StoreImageFormat,
} from '../src/lib/store-image.js';
import { MARK_GRID_SIZE, MARK_HUES, channels, shade, storeMark } from '../src/lib/store-mark.js';
import { renderStoreMarkIconPng, renderStoreMarkPixels, renderStoreMarkPng } from '../src/lib/store-mark-raster.js';
import { encodePng } from '../src/lib/png.js';
import { cdnFill } from '../src/config/store.config.js';

const CLOUDINARY = 'https://res.cloudinary.com/demo/image/upload/v123/store.jpg';
const EXTERNAL = 'https://cdn.dummyjson.com/product-images/tops/1.webp';
const FORMATS = Object.keys(STORE_IMAGE_FORMATS) as StoreImageFormat[];

describe('store mark identity', () => {
  it('is deterministic per slug', () => {
    expect(storeMark('bella-shop', 'Bella')).toEqual(storeMark('bella-shop', 'Bella'));
  });

  it('spreads stores across the hue palette', () => {
    const used = new Set(Array.from({ length: 40 }, (_, i) => storeMark(`store-${i}`).hue));
    expect(used.size).toBe(MARK_HUES.length);
  });

  it('keeps its hexes in sync with the tile tokens in tokens.css', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/base/tokens.css'), 'utf8');
    const tokens = [...css.matchAll(/--color-tile-[a-z]+:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]!.toLowerCase());
    expect(tokens).toEqual([...MARK_HUES]);
  });

  it('mirrors the grid left-to-right and never renders it empty or solid', () => {
    for (let i = 0; i < 60; i++) {
      const { grid } = storeMark(`seed-${i}`);
      expect(grid).toHaveLength(MARK_GRID_SIZE * MARK_GRID_SIZE);
      for (let row = 0; row < MARK_GRID_SIZE; row++) {
        for (let col = 0; col < MARK_GRID_SIZE; col++) {
          expect(grid[row * MARK_GRID_SIZE + col]).toBe(grid[row * MARK_GRID_SIZE + (MARK_GRID_SIZE - 1 - col)]);
        }
      }
      const on = grid.filter(Boolean).length;
      expect(on).toBeGreaterThan(0);
      expect(on).toBeLessThan(grid.length);
    }
  });

  it('produces different marks for different stores', () => {
    const marks = Array.from({ length: 30 }, (_, i) => JSON.stringify(storeMark(`store-${i}`)));
    expect(new Set(marks).size).toBe(marks.length);
  });

  it('shades toward white and black without leaving the channel range', () => {
    expect(shade('#2563c9', 1)).toBe('#ffffff');
    expect(shade('#2563c9', -1)).toBe('#000000');
    expect(channels('#ffffff')).toEqual([255, 255, 255]);
  });

  it('falls back to a placeholder initial when the name is empty', () => {
    expect(storeMark('x-shop', '   ').initial).toBe('X');
  });
});

describe('generated mark PNG', () => {
  it('encodes a valid PNG with the requested dimensions', () => {
    const png = renderStoreMarkPng(storeMark('bella-shop', 'Bella'), 64, 32);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(32);
    expect(png.subarray(png.length - 8, png.length - 4).toString('latin1')).toBe('IEND');
  });

  it('rejects a pixel buffer that does not match the dimensions', () => {
    expect(() => encodePng(4, 4, new Uint8Array(10))).toThrow();
  });

  it('draws both the gradient and the white mark (never one flat colour)', () => {
    const pixels = renderStoreMarkPixels(storeMark('bella-shop', 'Bella'), 120, 120);
    const distinct = new Set<string>();
    for (let i = 0; i < pixels.length; i += 3) distinct.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    expect(distinct.size).toBeGreaterThan(50);
    // The centre of the tile is inside the grid area; the corners are gradient.
    const centre = (120 * 60 + 60) * 3;
    expect(pixels[centre]).not.toBe(pixels[0]);
  });

  // Encodes every share-image size in pure JS — ~1.5s alone, but it shares CPU with the rest of the
  // suite, so the default 5s timeout made it fail on load rather than on merit.
  //
  // **The per-test 20s override that used to sit here is gone, and its absence is the fix
  // (2026-08-04).** `vitest.config.ts` raised the SUITE timeout to 30s for exactly this class —
  // CPU-bound work going red because eight workers and `astro check` are competing for twelve
  // cores, never because anything is wrong — and a local override BELOW that ceiling can only
  // reintroduce what the raise removed. It did: this test took 22.7s in a full run and 1.9s alone.
  // Nothing here waits on a network or a human, so the suite-wide 30s already means "hung", and a
  // second, stricter number in one file was a private answer to a question the project had settled.
  it('renders every whitelisted format', () => {
    for (const format of FORMATS) {
      const { width, height } = STORE_IMAGE_FORMATS[format];
      const png = renderStoreMarkPng(storeMark('bella-shop'), width, height);
      expect(png.readUInt32BE(16)).toBe(width);
      expect(png.readUInt32BE(20)).toBe(height);
    }
  });
});

describe('cdnFill', () => {
  it('forces exact dimensions on a Cloudinary upload', () => {
    expect(cdnFill(CLOUDINARY, 1200, 628)).toBe(
      'https://res.cloudinary.com/demo/image/upload/c_fill,g_auto,f_jpg,q_auto,w_1200,h_628/v123/store.jpg',
    );
  });

  it('replaces an existing transformation instead of stacking one', () => {
    const already = 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_400/v123/store.jpg';
    expect(cdnFill(already, 512, 512)).toBe(
      'https://res.cloudinary.com/demo/image/upload/c_fill,g_auto,f_jpg,q_auto,w_512,h_512/v123/store.jpg',
    );
  });

  it('returns empty for a URL whose size it cannot guarantee', () => {
    expect(cdnFill(EXTERNAL, 512, 512)).toBe('');
  });
});

describe('store image resolution', () => {
  it('never returns an empty source, for any format, with no images at all', () => {
    for (const format of FORMATS) {
      const { src, hasUpload } = resolveStoreImage({ slug: 'bella-shop' }, format);
      expect(hasUpload).toBe(false);
      expect(src).toBe(storeMarkPath('bella-shop', format));
    }
  });

  it('uses the seller upload at the exact size when it is transformable', () => {
    const { src, hasUpload } = resolveStoreImage({ slug: 'bella-shop', profileImage: CLOUDINARY }, 'logo');
    expect(hasUpload).toBe(true);
    expect(src).toContain('w_512,h_512');
  });

  it('prefers the banner for wide formats and the avatar for square ones', () => {
    const store = { slug: 'bella-shop', profileImage: CLOUDINARY, bannerImage: CLOUDINARY.replace('store', 'banner') };
    expect(resolveStoreImage(store, 'landscape').src).toContain('banner');
    expect(resolveStoreImage(store, 'portrait').src).toContain('banner');
    expect(resolveStoreImage(store, 'logo').src).toContain('store');
    expect(resolveStoreImage(store, 'square').src).toContain('store');
  });

  it('falls back to the mark rather than serve an untransformable image at the wrong ratio', () => {
    const { src, hasUpload } = resolveStoreImage({ slug: 'bella-shop', profileImage: EXTERNAL }, 'landscape');
    expect(hasUpload).toBe(false);
    expect(src).toBe(storeMarkPath('bella-shop', 'landscape'));
  });

  it('skips a blank image field', () => {
    expect(resolveStoreImage({ slug: 'bella-shop', profileImage: '  ' }, 'logo').hasUpload).toBe(false);
  });

  it('returns absolute URLs for off-site consumers', () => {
    expect(storeImageUrl({ slug: 'bella-shop' }, 'landscape', 'https://dezabin.co.il/')).toBe(
      'https://dezabin.co.il/api/store-image/bella-shop/landscape.png',
    );
    expect(storeImageUrl({ slug: 'bella-shop', profileImage: CLOUDINARY }, 'square', 'https://dezabin.co.il')).toContain(
      'res.cloudinary.com',
    );
  });
});

describe('ad creative set', () => {
  it('is complete and absolute for a store with no uploads at all', () => {
    const creative = storeAdCreative({ slug: 'bella-shop' }, 'https://dezabin.co.il');
    expect(Object.keys(creative).sort()).toEqual([...FORMATS].sort());
    for (const url of Object.values(creative)) expect(url.startsWith('https://dezabin.co.il/')).toBe(true);
  });

  it('uses the seller’s own imagery where it can, per ratio', () => {
    const creative = storeAdCreative(
      { slug: 'bella-shop', profileImage: CLOUDINARY, bannerImage: CLOUDINARY.replace('store', 'banner') },
      'https://dezabin.co.il',
    );
    expect(creative.logo).toContain('w_512,h_512');
    expect(creative.landscape).toContain('w_1200,h_628');
    expect(creative.portrait).toContain('banner');
  });
});

describe('mark URL round-trip', () => {
  it('keeps the slug in its own path segment, whatever it contains', () => {
    expect(storeMarkPath('my-cool-store', 'square')).toBe('/api/store-image/my-cool-store/square.png');
    // A trailing-hyphen slug is what broke a single-filename scheme: '<slug>-<format>'
    // could no longer be split back apart unambiguously.
    expect(storeMarkPath('-', 'square')).toBe('/api/store-image/-/square.png');
  });

  it('round-trips every format', () => {
    for (const format of FORMATS) {
      const file = storeMarkPath('bella-shop', format).split('/').pop()!;
      expect(parseStoreImageFile(file)).toBe(format);
    }
  });

  it('rejects anything outside the whitelist', () => {
    expect(parseStoreImageFile('huge.png')).toBeNull();
    expect(parseStoreImageFile('square.svg')).toBeNull();
    expect(parseStoreImageFile('../../etc/passwd')).toBeNull();
    expect(parseStoreImageFile('')).toBeNull();
    expect(isStoreRenderFormat('banner')).toBe(false);
  });

  it('uses a ratio social platforms crop cleanly for og:image', () => {
    const { width, height } = STORE_IMAGE_FORMATS[OG_IMAGE_FORMAT];
    expect(width / height).toBeCloseTo(1.91, 1);
  });
});

describe('store favicon', () => {
  it('never hands an ad platform a browser icon', () => {
    // The whole reason STORE_ICON_FORMATS is a second map: storeAdCreative submits
    // EVERY entry of STORE_IMAGE_FORMATS as a creative, so a favicon merged in
    // there would be offered to Google and Meta as an image to advertise with.
    const creative = storeAdCreative({ slug: 'bella-shop' }, 'https://dezabin.co.il');
    for (const format of Object.keys(STORE_ICON_FORMATS)) {
      expect(Object.keys(creative)).not.toContain(format);
    }
  });

  it('still renders, and round-trips, through the one mark endpoint', () => {
    for (const format of Object.keys(STORE_ICON_FORMATS) as StoreIconFormat[]) {
      const file = storeMarkPath('bella-shop', format).split('/').pop()!;
      expect(parseStoreImageFile(file)).toBe(format);
      expect(STORE_RENDER_FORMATS[format]).toEqual(STORE_ICON_FORMATS[format]);
    }
  });

  it('is square — a tab strip crops anything else', () => {
    for (const { width, height } of Object.values(STORE_ICON_FORMATS)) expect(width).toBe(height);
  });

  it('is a CIRCLE in the tab and deliberately not on the iOS home screen', () => {
    // Round, because a store's identity is round everywhere else here (StoreAvatar).
    expect(ROUND_ICON_FORMATS).toContain('favicon');
    // NOT round, because iOS masks this one itself and composites transparency
    // onto black — a round source arrives with black corners.
    expect(ROUND_ICON_FORMATS).not.toContain('touch');
  });

  it('cuts the circle out of an upload in a format that HAS alpha', () => {
    const icon = storeIconUrl({ slug: 'bella-shop', profileImage: CLOUDINARY }, 'favicon');
    expect(icon).toContain('r_max');
    // f_auto could pick JPEG for a photo, and JPEG has no alpha — the corners the
    // radius just cut would come back black.
    expect(icon).toContain('f_png');
    expect(icon).not.toContain('f_auto');
    expect(storeIconUrl({ slug: 'bella-shop', profileImage: CLOUDINARY }, 'touch')).not.toContain('r_max');
  });

  it('renders the generated mark round, with genuinely transparent corners', () => {
    const size = STORE_ICON_FORMATS.favicon.width;
    const png = renderStoreMarkIconPng(storeMark('bella-shop', 'Bella'), size);
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.subarray(24, 25)[0]).toBe(8);   // bit depth
    expect(png.subarray(25, 26)[0]).toBe(6);   // colour type 6 = truecolour + alpha
    expect(() => renderStoreMarkIconPng(storeMark('bella-shop'), 4)).toThrow();
  });

  it('leaves the opaque encoder opaque', () => {
    const png = renderStoreMarkPng(storeMark('bella-shop'), 64, 64);
    expect(png.subarray(25, 26)[0]).toBe(2);   // colour type 2 = truecolour, no alpha
  });

  it('never takes the ad path’s f_jpg — a JPEG icon has no transparency at all', () => {
    // cdnFill forces f_jpg for scrapers that send no usable Accept header. Reuse it
    // here and a logo uploaded on a transparent background becomes a black square.
    for (const f of Object.keys(STORE_ICON_FORMATS) as StoreIconFormat[]) {
      const icon = storeIconUrl({ slug: 'bella-shop', profileImage: CLOUDINARY }, f);
      expect(icon).not.toContain('f_jpg');
      const { width, height } = STORE_ICON_FORMATS[f];
      expect(icon).toContain(`w_${width},h_${height}`);
    }
  });

  it('falls back to the store’s own mark rather than a full-size original', () => {
    expect(storeIconUrl({ slug: 'bella-shop' }, 'favicon')).toBe('/api/store-image/bella-shop/favicon.png');
    expect(storeIconUrl({ slug: 'bella-shop', profileImage: '  ' }, 'touch')).toBe(
      '/api/store-image/bella-shop/touch.png',
    );
    // An untransformable source is refused for the same reason the ad path refuses
    // it: a 2MB original in a 32px tab is a cost with no benefit.
    const unusable = 'https://example.com/logo.png';
    const icon = storeIconUrl({ slug: 'bella-shop', profileImage: unusable }, 'favicon');
    expect(icon === unusable).toBe(false);
  });
});

describe('the uncropped original stays paired with its crop', () => {
  const CROP_A = 'https://res.cloudinary.com/demo/image/upload/v1/crop-a.png';
  const CROP_B = 'https://res.cloudinary.com/demo/image/upload/v1/crop-b.png';
  const SRC_A  = 'https://res.cloudinary.com/demo/image/upload/v1/src-a.jpg';
  const SRC_B  = 'https://res.cloudinary.com/demo/image/upload/v1/src-b.jpg';

  it('takes this tab\u2019s original when this tab\u2019s crop won the merge', () => {
    expect(pairedImageSource({
      chosen: CROP_A, submitted: CROP_A, submittedSource: SRC_A, stored: CROP_B, storedSource: SRC_B,
    })).toBe(SRC_A);
  });

  it('takes the stored original when another tab\u2019s crop won', () => {
    // This seller\u2019s crop lost the merge, so their original has to lose with it — otherwise
    // "adjust" opens a photo that has nothing to do with the avatar on screen.
    expect(pairedImageSource({
      chosen: CROP_B, submitted: CROP_A, submittedSource: SRC_A, stored: CROP_B, storedSource: SRC_B,
    })).toBe(SRC_B);
  });

  it('keeps the stored original when the image itself did not change', () => {
    // Including when the request carries no source field at all (a tab still running the previous
    // deploy, or a hand-built POST): an unchanged picture must never cost the seller its original.
    expect(pairedImageSource({
      chosen: CROP_A, submitted: CROP_A, submittedSource: undefined, stored: CROP_A, storedSource: SRC_A,
    })).toBe(SRC_A);
    expect(pairedImageSource({
      chosen: CROP_A, submitted: undefined, submittedSource: undefined, stored: CROP_A, storedSource: SRC_A,
    })).toBe(SRC_A);
  });

  it('drops the original when the image was removed', () => {
    expect(pairedImageSource({
      chosen: undefined, submitted: undefined, submittedSource: SRC_A, stored: CROP_A, storedSource: SRC_B,
    })).toBe(undefined);
    expect(pairedImageSource({
      chosen: '', submitted: '', submittedSource: SRC_A, stored: CROP_A, storedSource: SRC_B,
    })).toBe(undefined);
  });

  it('carries no original when there never was one (uploaded before 0012)', () => {
    expect(pairedImageSource({
      chosen: CROP_A, submitted: CROP_A, submittedSource: undefined, stored: undefined, storedSource: undefined,
    })).toBe(undefined);
  });
});
