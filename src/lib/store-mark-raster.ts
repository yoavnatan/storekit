import { encodePng } from './png.js';
import { MARK_GRID_SIZE, channels, type StoreMark } from './store-mark.js';

/**
 * Draws a `StoreMark` as a PNG at any size/aspect ratio — the raster half of
 * the identity defined in store-mark.ts (the on-site half is CSS/SVG).
 *
 * Everything is plain arithmetic over a pixel buffer: a diagonal gradient in
 * the store's hue, with the mark's grid on top in white. No fonts are involved
 * anywhere, deliberately — a text glyph would need a font rasteriser, and the
 * store names here are Hebrew, which is exactly where a server-side font
 * fallback silently renders boxes on a machine that lacks the family. A
 * geometric mark can't fail that way on any host.
 */

/** Share of the shorter side the grid occupies — the rest is breathing room, so
 *  the mark survives the circular/rounded crops ad platforms apply. */
const GRID_SCALE = 0.56;
/** Corner rounding of one block, as a share of the cell. */
const BLOCK_RADIUS = 0.24;
/** Gap between blocks, as a share of the cell. */
const BLOCK_GAP = 0.16;
/** Block opacity over the gradient. Not 1: a hint of the hue through the white
 *  keeps the mark one object instead of two stacked layers. */
const BLOCK_ALPHA = 0.93;
/** Subsamples per axis. 2×2 is enough to take the stair-stepping off the
 *  rounded corners at every size we emit. */
const SUBSAMPLES = 2;

interface GridGeometry {
  originX: number;
  originY: number;
  cell: number;
}

function gridGeometry(width: number, height: number): GridGeometry {
  const cell = (Math.min(width, height) * GRID_SCALE) / MARK_GRID_SIZE;
  const span = cell * MARK_GRID_SIZE;
  return { originX: (width - span) / 2, originY: (height - span) / 2, cell };
}

/** Is this point inside a filled, rounded block of the grid? */
function insideBlock(mark: StoreMark, geo: GridGeometry, px: number, py: number): boolean {
  const col = Math.floor((px - geo.originX) / geo.cell);
  const row = Math.floor((py - geo.originY) / geo.cell);
  if (col < 0 || row < 0 || col >= MARK_GRID_SIZE || row >= MARK_GRID_SIZE) return false;
  if (!mark.grid[row * MARK_GRID_SIZE + col]) return false;

  // Local coordinates inside the cell, measured from its centre.
  const half = geo.cell / 2;
  const inset = geo.cell * (BLOCK_GAP / 2);
  const reach = half - inset;
  const dx = Math.abs(px - (geo.originX + col * geo.cell + half));
  const dy = Math.abs(py - (geo.originY + row * geo.cell + half));
  if (dx > reach || dy > reach) return false;

  const radius = geo.cell * BLOCK_RADIUS;
  const cornerX = dx - (reach - radius);
  const cornerY = dy - (reach - radius);
  if (cornerX <= 0 || cornerY <= 0) return true;
  return cornerX * cornerX + cornerY * cornerY <= radius * radius;
}

/**
 * `width * height * 3` RGB bytes for the mark. Exported for tests — the PNG
 * wrapper is the thing callers want.
 */
export function renderStoreMarkPixels(mark: StoreMark, width: number, height: number): Uint8Array {
  const [r0, g0, b0] = channels(mark.from);
  const [r1, g1, b1] = channels(mark.to);
  const geo = gridGeometry(width, height);
  const out = new Uint8Array(width * height * 3);
  const step = 1 / SUBSAMPLES;
  const samples = SUBSAMPLES * SUBSAMPLES;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Diagonal (135°) gradient: both axes contribute equally, so the sweep
      // runs corner to corner whatever the aspect ratio.
      const t = (x / Math.max(1, width - 1) + y / Math.max(1, height - 1)) / 2;

      let hits = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy++) {
        for (let sx = 0; sx < SUBSAMPLES; sx++) {
          if (insideBlock(mark, geo, x + (sx + 0.5) * step, y + (sy + 0.5) * step)) hits++;
        }
      }
      const cover = (hits / samples) * BLOCK_ALPHA;

      const i = (y * width + x) * 3;
      out[i] = mixToWhite(r0 + (r1 - r0) * t, cover);
      out[i + 1] = mixToWhite(g0 + (g1 - g0) * t, cover);
      out[i + 2] = mixToWhite(b0 + (b1 - b0) * t, cover);
    }
  }
  return out;
}

function mixToWhite(channel: number, cover: number): number {
  return Math.round(channel + (255 - channel) * cover);
}

export function renderStoreMarkPng(mark: StoreMark, width: number, height: number): Buffer {
  return encodePng(width, height, renderStoreMarkPixels(mark, width, height));
}
