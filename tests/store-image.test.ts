import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OG_IMAGE_FORMAT,
  STORE_IMAGE_FORMATS,
  isStoreImageFormat,
  parseStoreImageFile,
  resolveStoreImage,
  storeAdCreative,
  storeImageUrl,
  storeMarkPath,
  type StoreImageFormat,
} from '../src/lib/store-image.js';
import { MARK_GRID_SIZE, MARK_HUES, channels, shade, storeMark } from '../src/lib/store-mark.js';
import { renderStoreMarkPixels, renderStoreMarkPng } from '../src/lib/store-mark-raster.js';
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

  // Encodes every share-image size in pure JS — ~1.5s alone, but it shares CPU with the
  // rest of the suite, so the default 5s timeout made it fail on load rather than on merit.
  it('renders every whitelisted format', () => {
    for (const format of FORMATS) {
      const { width, height } = STORE_IMAGE_FORMATS[format];
      const png = renderStoreMarkPng(storeMark('bella-shop'), width, height);
      expect(png.readUInt32BE(16)).toBe(width);
      expect(png.readUInt32BE(20)).toBe(height);
    }
  }, 20_000);
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
    expect(isStoreImageFormat('banner')).toBe(false);
  });

  it('uses a ratio social platforms crop cleanly for og:image', () => {
    const { width, height } = STORE_IMAGE_FORMATS[OG_IMAGE_FORMAT];
    expect(width / height).toBeCloseTo(1.91, 1);
  });
});
