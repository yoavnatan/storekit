/**
 * Repaints a store avatar's halo in that store's own colour.
 *
 * The halo itself is pure CSS (`.store-glow-wrap`, utilities/utils.css) and
 * defaults to a neutral grey; all this does is set `--store-glow` on the
 * surrounding `[data-glow-host]` once the avatar's pixels are readable. So every
 * failure mode here — no CORS header, a tainted canvas, a black-and-white logo,
 * JS off entirely — lands on the grey halo that shipped before, never on no halo.
 *
 * Two surfaces have a host today: the store card, and the spotlight carousel's
 * store header. The same colour feeds the card's hover border (store-card.css).
 *
 * Costs no extra bytes: it samples the avatar image the page was already
 * loading (tagged `data-glow` by StoreAvatar, which also sets `crossorigin`
 * so the canvas stays readable), reduced to 24×24 in a single shared canvas.
 * Results are memoised per image URL in sessionStorage, so moving between the
 * homepage and /stores doesn't re-decode the same twenty logos.
 */
import { dominantGlowColor } from '../lib/dominant-color.js';

/** Enough pixels for a logo's colour split, few enough that the readback is free. */
const SAMPLE = 24;
const CACHE_KEY = 'sn_store_glow';
const CACHE_CAP = 80;

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let cache: Record<string, string> | null = null;

/** '' (no usable colour) or a 6-digit hex — the only two things this cache may
 *  hold. Anything else is a stale format from an older build, another feature
 *  reusing the key, or tampering; none of them may reach `setProperty`. */
function validCached(v: unknown): v is string {
  return v === '' || (typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v));
}

function readCache(): Record<string, string> {
  if (cache) return cache;
  cache = {};
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) if (validCached(v)) cache[k] = v;
    }
  } catch {
    // Private mode, quota, or a corrupt entry — memoise in memory only.
  }
  return cache;
}

function writeCache(src: string, hex: string): void {
  const c = readCache();
  const keys = Object.keys(c);
  if (keys.length >= CACHE_CAP && !(src in c)) delete c[keys[0]!];
  c[src] = hex;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* nothing to do — the colour is still cached for this page */
  }
}

/** The image's dominant colour, or null when it has none / can't be read. */
function sample(img: HTMLImageElement): string | null {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) return null;
  try {
    ctx.clearRect(0, 0, SAMPLE, SAMPLE);
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    return dominantGlowColor(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
  } catch {
    // A missing CORS header taints the canvas and getImageData throws. Keep the
    // default glow rather than letting one image break the rest of the shelf.
    return null;
  }
}

function apply(img: HTMLImageElement): void {
  // The element that OWNS this store's colour, marked `data-glow-host` by whoever
  // renders it — a store card, or the spotlight carousel's store header. It used
  // to be hardcoded to `.store-card`, which silently made the whole mechanism
  // card-only: a second surface could add the halo markup and the avatar's
  // `data-glow`, and the colour would simply never be set on it, with no error.
  const host = img.closest<HTMLElement>('[data-glow-host]');
  const src = img.currentSrc || img.src;
  if (!host || !src) return;
  const cached = readCache()[src];
  // '' is a real answer ("this logo has no usable colour"), not a cache miss.
  const hex = cached !== undefined ? cached : sample(img) ?? '';
  if (cached === undefined) writeCache(src, hex);
  if (hex) host.style.setProperty('--store-glow', hex);
}

export function initStoreGlow(): void {
  // Every store card is server-rendered, so one pass at load reaches all of them
  // — there is no client-rendered card that would need a subtree argument here.
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img[data-glow]'));
  if (!imgs.length) return;
  // Idle, because a halo that only appears on hover has no business competing
  // with first paint. Cards below the fold are lazy-loaded, so most arrive
  // through the load listener anyway.
  const run = () => {
    for (const img of imgs) {
      if (img.complete && img.naturalWidth) apply(img);
      else img.addEventListener('load', () => apply(img), { once: true });
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 0);
}
