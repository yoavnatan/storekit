/**
 * The one colour a picture is "about" — used for the halo behind a store's
 * avatar on a store card AND for that card's hover border, so both belong to
 * the store's own logo instead of every card on the homepage sharing the
 * platform accent.
 *
 * Deliberately NOT an average, at either of the two steps. Averaging a logo (a
 * coloured mark on a white plate) returns a pale wash of the plate, which at
 * the halo's ~13% opacity is invisible — the exact failure this file exists to
 * avoid. So: every pixel that carries visible colour votes for a hue bucket
 * (step 1, which hue), and then only the most saturated pixels INSIDE the
 * winning hue decide the colour returned (step 2, which shade of it).
 *
 * Step 2 is what the second consumer forced (2026-08-05). Taking the winning
 * hue's mean saturation is still an average, just a narrower one, and it lands
 * a red logo on a dusty brick rather than on its red: a downscaled sample
 * blends every edge pixel of the mark with the white behind it, and those
 * washed-out fringe pixels outnumber the flat interior of a thin mark. Fine at
 * 13% opacity behind an avatar, plainly wrong as a 1px border the eye reads as
 * a line of colour. The vivid head of the distribution is what a person would
 * name as "that logo's colour", so that is what gets returned.
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
 *  any colour at all gets a halo you can actually see. The saturation floor was
 *  raised from 0.45 when the hover border started reading this: a border is a
 *  line, not a wash, and 0.45 on a light grey edge reads as "slightly dirty
 *  grey" rather than as the store's colour. */
const SAT_MIN = 0.55;
const SAT_MAX = 0.95;
const LIGHT_MIN = 0.38;
const LIGHT_MAX = 0.6;

/** How much of the winning hue's own pixels decide its shade — the most
 *  saturated quarter. Not 1 pixel (a single JPEG artefact would name the
 *  colour) and not all of them (that is the average this file rejects). */
const VIVID_SHARE = 0.25;

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
  let opaque = 0;
  // Every pixel that carries colour, kept so step 2 can go back over the
  // winning hue's own pixels. A 24×24 sample is 576 of them (store-glow.ts),
  // so this is a few kilobytes for the length of one call.
  const lit: Array<{ h: number; s: number; l: number; b: number }> = [];

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3]! < MIN_ALPHA) continue;
    opaque++;
    const { h, s, l } = rgbToHsl(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    if (s < MIN_SAT || l < MIN_LIGHT || l > MAX_LIGHT) continue;
    const b = Math.min(BUCKETS - 1, Math.floor(h / BUCKET_DEG));
    lit.push({ h, s, l, b });
    // Vivid mid-tones speak loudest: they are what a viewer would name as
    // "the colour of that logo".
    weight[b]! += s * (1 - Math.abs(l - 0.5));
  }

  if (!opaque || lit.length / opaque < MIN_COLOURED_SHARE) return null;

  // ── Step 1: which hue ───────────────────────────────────────────────
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

  // ── Step 2: which shade of it ───────────────────────────────────────
  const next = (best + 1) % BUCKETS;
  const family = lit.filter((p) => p.b === best || p.b === next);
  // Descending saturation, then the head of it. `sort` is stable in every
  // engine this ships to, so equally saturated pixels keep buffer order and the
  // answer is deterministic for a given image.
  family.sort((a, b) => b.s - a.s);
  const head = family.slice(0, Math.max(1, Math.round(family.length * VIVID_SHARE)));

  // Hue accumulates as unit vectors, never as a plain mean: red straddles 0°,
  // so averaging 355° with 5° the arithmetic way returns cyan.
  let hx = 0;
  let hy = 0;
  let sSum = 0;
  let lSum = 0;
  for (const p of head) {
    const rad = (p.h * Math.PI) / 180;
    hx += Math.cos(rad) * p.s;
    hy += Math.sin(rad) * p.s;
    sSum += p.s;
    lSum += p.l;
  }
  const h = ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360;
  const s = clamp(sSum / head.length, SAT_MIN, SAT_MAX);
  const l = clamp(lSum / head.length, LIGHT_MIN, LIGHT_MAX);
  return hslToHex(h, s, l);
}
