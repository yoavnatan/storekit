import { deflateSync } from 'node:zlib';

/**
 * Minimal PNG encoder (8-bit truecolour, with or without alpha).
 *
 * Deliberately dependency-free: the only image pipeline this repo has is
 * Cloudinary (remote, for images somebody uploaded) and `astro:assets` (build
 * time, for files on disk). Neither can synthesise a *generated* image at
 * request time, and adding a native rasteriser (sharp/resvg) for a few flat
 * rectangles would pull a platform-specific binary into the deploy for no other
 * caller. Everything here is integer maths over a byte buffer plus Node's own
 * zlib, so it runs identically anywhere Node runs.
 *
 * Why raster at all, when SVG is smaller and already in use on-site: the
 * consumers are external. Meta/Google ad creative, `og:image` (WhatsApp,
 * Facebook, iMessage) and most structured-data image crawlers accept JPEG/PNG
 * and reject or ignore SVG — see store-image.ts.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BYTES_PER_PIXEL = 3; // RGB

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length + type + data + CRC over (type + data). */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode a raw RGB buffer (`width * height * 3` bytes, row-major) as a PNG.
 *
 * Rows use the Sub filter (each byte stored as its delta from the pixel to its
 * left): the images this produces are linear gradients, whose horizontal delta
 * is constant, so Sub turns a multi-megabyte pixel buffer into a few KB after
 * deflate. Filter 0 (none) would work identically but compress ~10x worse.
 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  return encode(width, height, rgb, BYTES_PER_PIXEL);
}

/**
 * As `encodePng`, for a `width * height * 4` RGBA buffer — used by the round
 * favicon, whose corners have to be genuinely transparent rather than white
 * (store-mark-raster.ts#renderStoreMarkIconPixels).
 *
 * Kept as a second entry point rather than a flag on the first: everything that
 * leaves this platform for an ad network or a social scraper is opaque by
 * contract, and a caller should have to say the word "rgba" to get alpha.
 */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Buffer {
  return encode(width, height, rgba, 4);
}

function encode(width: number, height: number, pixels: Uint8Array, bpp: 3 | 4): Buffer {
  const stride = width * bpp;
  if (pixels.length !== stride * height) {
    throw new Error(`encodePng: expected ${stride * height} bytes, got ${pixels.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = bpp === 4 ? 6 : 2; // colour type: truecolour + alpha, or truecolour
  // bytes 10-12 stay 0: deflate compression, adaptive filtering, no interlace.

  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 1; // Sub
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? pixels[src + x - bpp]! : 0;
      raw[dst + 1 + x] = (pixels[src + x]! - left) & 0xff;
    }
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
