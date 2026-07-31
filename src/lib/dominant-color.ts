/**
 * The one colour a picture is "about" — used for the halo behind a store's
 * avatar on a store card, so the glow belongs to that store's own logo instead
 * of every card on the homepage sharing the platform accent.
 *
 * Deliberately NOT an average. Averaging a logo (a coloured mark on a white
 * plate) returns a pale wash of the plate, which at the halo's ~13% opacity is
 * invisible — the exact failure this file exists to avoid. Instead every pixel
 * that carries visible colour votes for a hue bucket, and the winning bucket's
 * colour is pulled into the lightness/saturation band where a soft glow
 * actually reads on a light surface.
 *
 * Pure and DOM-free (the caller hands over pixels), so the canvas plumbing
 * stays in scripts/store-glow.ts and the decision itself stays unit-testable.
 */

/** 15° each — narrow enough to separate orange from yellow, wide enough that
 *  JPEG noise inside one flat logo colour doesn't split its vote. */
const BUCKETS = 24;
const BUCKET_DEG = 360 / BUCKETS;

// What counts as "carries visible colour". Transparent, near-white, near-black
// and washed-out greys are the plate a mark sits on, not the mark.
const MIN_ALPHA = 128;
const MIN_SAT = 0.15;
const MIN_LIGHT = 0.07;
const MAX_LIGHT = 0.9;

/** …and enough of the picture has to be coloured at all, so a handful of
 *  anti-aliasing pixels on a genuinely white logo can't decide the halo. Below
 *  this the caller gets null and keeps the default accent glow — which is the
 *  honest answer for a black-and-white mark. */
const MIN_COLOURED_SHARE = 0.02;

/** The band a glow is visible in, on this site's light surfaces. A pastel logo
 *  clamps UP into it and a near-black one clamps down, so every store that has
 *  any colour at all gets a halo you can actually see. */
const SAT_MIN = 0.45;
const SAT_MAX = 0.95;
const LIGHT_MIN = 0.38;
const LIGHT_MAX = 0.6;

export interface Hsl {
  /** 0–360 */
  h: number;
  /** 0–1 */
  s: number;
  /** 0–1 */
  l: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return { h: (h + 360) % 360, s, l };
}

export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(((h % 360) + 360) % 360 / 60);
  const rgb = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][sector]!;
  return `#${rgb.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The glow colour for one image's pixels (RGBA, 4 bytes per pixel — an
 * `ImageData.data`), or null when the picture has no colour worth showing.
 */
export function dominantGlowColor(pixels: ArrayLike<number>): string | null {
  const weight = new Array<number>(BUCKETS).fill(0);
  // Hue accumulates as unit vectors, never as a plain mean: red straddles 0°,
  // so averaging 355° with 5° the arithmetic way returns cyan.
  const hx = new Array<number>(BUCKETS).fill(0);
  const hy = new Array<number>(BUCKETS).fill(0);
  const sSum = new Array<number>(BUCKETS).fill(0);
  const lSum = new Array<number>(BUCKETS).fill(0);
  let opaque = 0;
  let coloured = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3]! < MIN_ALPHA) continue;
    opaque++;
    const { h, s, l } = rgbToHsl(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    if (s < MIN_SAT || l < MIN_LIGHT || l > MAX_LIGHT) continue;
    coloured++;
    // Vivid mid-tones speak loudest: they are what a viewer would name as
    // "the colour of that logo".
    const w = s * (1 - Math.abs(l - 0.5));
    const b = Math.min(BUCKETS - 1, Math.floor(h / BUCKET_DEG));
    const rad = (h * Math.PI) / 180;
    weight[b]! += w;
    hx[b]! += Math.cos(rad) * w;
    hy[b]! += Math.sin(rad) * w;
    sSum[b]! += s * w;
    lSum[b]! += l * w;
  }

  if (!opaque || coloured / opaque < MIN_COLOURED_SHARE) return null;

  // Scored in adjacent PAIRS, not single buckets: one flat logo colour landing
  // near a bucket edge splits its vote in two, and a smaller rival that happens
  // to sit mid-bucket would win on the raw count.
  let best = 0;
  let bestScore = -1;
  for (let b = 0; b < BUCKETS; b++) {
    const score = weight[b]! + weight[(b + 1) % BUCKETS]!;
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  if (bestScore <= 0) return null;

  const next = (best + 1) % BUCKETS;
  const total = weight[best]! + weight[next]!;
  const h = ((Math.atan2(hy[best]! + hy[next]!, hx[best]! + hx[next]!) * 180) / Math.PI + 360) % 360;
  const s = clamp((sSum[best]! + sSum[next]!) / total, SAT_MIN, SAT_MAX);
  const l = clamp((lSum[best]! + lSum[next]!) / total, LIGHT_MIN, LIGHT_MAX);
  return hslToHex(h, s, l);
}
