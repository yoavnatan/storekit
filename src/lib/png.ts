import { deflateSync } from 'node:zlib';

/**
 * Minimal PNG encoder (8-bit truecolour, no alpha).
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
  const stride = width * BYTES_PER_PIXEL;
  if (rgb.length !== stride * height) {
    throw new Error(`encodePng: expected ${stride * height} bytes, got ${rgb.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour (RGB)
  // bytes 10-12 stay 0: deflate compression, adaptive filtering, no interlace.

  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 1; // Sub
    for (let x = 0; x < stride; x++) {
      const left = x >= BYTES_PER_PIXEL ? rgb[src + x - BYTES_PER_PIXEL]! : 0;
      raw[dst + 1 + x] = (rgb[src + x]! - left) & 0xff;
    }
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
