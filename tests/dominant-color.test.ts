// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dominantGlowColor, rgbToHsl, hslToHex } from '../src/lib/dominant-color.js';
import { cdnIsSampleable } from '../src/lib/cdn.js';


/** An RGBA buffer from a list of [r,g,b,a?] runs — `[[color, count], …]`. */
function pixels(runs: Array<[[number, number, number, number?], number]>): Uint8ClampedArray {
  const out: number[] = [];
  for (const [[r, g, b, a = 255], count] of runs) {
    for (let i = 0; i < count; i++) out.push(r, g, b, a);
  }
  return Uint8ClampedArray.from(out);
}

const WHITE: [number, number, number] = [255, 255, 255];
const hueOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return rgbToHsl((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff).h;
};
const lightnessOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return rgbToHsl((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff).l;
};
/** Circular hue distance, so a red answer near 0° isn't scored as 355° off. */
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('rgbToHsl / hslToHex round-trip', () => {
  it('preserves a saturated colour through both conversions', () => {
    const samples: Array<[number, number, number]> = [[220, 40, 40], [40, 90, 210], [30, 170, 110], [230, 170, 20]];
    for (const [r, g, b] of samples) {
      const { h, s, l } = rgbToHsl(r, g, b);
      const n = parseInt(hslToHex(h, s, l).slice(1), 16);
      expect(Math.abs(((n >> 16) & 0xff) - r)).toBeLessThanOrEqual(2);
      expect(Math.abs(((n >> 8) & 0xff) - g)).toBeLessThanOrEqual(2);
      expect(Math.abs((n & 0xff) - b)).toBeLessThanOrEqual(2);
    }
  });

  it('emits 6-digit hex for every hue sector', () => {
    for (let h = 0; h < 360; h += 17) expect(hslToHex(h, 0.7, 0.5)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('dominantGlowColor', () => {
  it('picks the mark, not the plate it sits on', () => {
    // The whole premise: a mostly-white logo with a blue mark must return blue.
    // An average would return near-white, which is invisible at the halo's mix.
    const hex = dominantGlowColor(pixels([[WHITE, 500], [[30, 90, 200], 76]]))!;
    expect(hex).not.toBeNull();
    expect(hueGap(hueOf(hex), 218)).toBeLessThan(20);
  });

  it('refuses a white or greyscale picture, so the card keeps the accent glow', () => {
    expect(dominantGlowColor(pixels([[WHITE, 576]]))).toBeNull();
    expect(dominantGlowColor(pixels([[WHITE, 400], [[20, 20, 20], 100], [[130, 130, 130], 76]]))).toBeNull();
  });

  it('refuses a picture whose only colour is a few anti-aliasing pixels', () => {
    // 5 coloured pixels out of 576 is under the 2% share — that is a black mark
    // with a fringe, not a coloured one.
    expect(dominantGlowColor(pixels([[WHITE, 500], [[20, 20, 20], 71], [[200, 40, 40], 5]]))).toBeNull();
  });

  it('ignores fully transparent pixels rather than counting them as black', () => {
    const hex = dominantGlowColor(pixels([[[0, 0, 0, 0], 500], [[30, 170, 110], 76]]))!;
    expect(hex).not.toBeNull();
    expect(hueGap(hueOf(hex), 156)).toBeLessThan(20);
  });

  it('keeps red red — the hue that straddles 0° and breaks a naive average', () => {
    // Half the reds sit just below 360° and half just above 0°. Averaging the
    // numbers would return cyan; the unit-vector accumulation must not.
    const hex = dominantGlowColor(pixels([[WHITE, 400], [[200, 30, 40], 90], [[200, 40, 30], 86]]))!;
    expect(hueGap(hueOf(hex), 0)).toBeLessThan(25);
  });

  it('pulls a pale colour into the band where a soft glow is actually visible', () => {
    // A pastel pink logo: its own lightness (~0.88) would vanish at 13% opacity.
    const hex = dominantGlowColor(pixels([[WHITE, 300], [[250, 205, 215], 276]]))!;
    expect(lightnessOf(hex)).toBeLessThanOrEqual(0.62);
    expect(lightnessOf(hex)).toBeGreaterThanOrEqual(0.36);
  });

  it('lifts a near-black-but-coloured logo instead of dropping it', () => {
    const hex = dominantGlowColor(pixels([[WHITE, 300], [[20, 30, 90], 276]]))!;
    expect(lightnessOf(hex)).toBeGreaterThanOrEqual(0.36);
    expect(hueGap(hueOf(hex), 231)).toBeLessThan(20);
  });

  it('answers the bigger mark when two colours compete', () => {
    const hex = dominantGlowColor(pixels([[WHITE, 200], [[220, 150, 20], 300], [[40, 90, 210], 76]]))!;
    expect(hueGap(hueOf(hex), 39)).toBeLessThan(20);
  });

  it('never returns a colour for an empty buffer', () => {
    expect(dominantGlowColor(new Uint8ClampedArray(0))).toBeNull();
  });
});

describe('the memoised colour is never trusted on the way back in', () => {
  const SRC = 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_80/v1/logo.png';

  /** One card with a sampleable avatar, already "loaded" — jsdom images never
   *  load, so `complete`/`naturalWidth` are forced to what a real one reports. */
  function card(): HTMLElement {
    document.body.innerHTML = '<a class="store-card"><span class="store-card__avatar-wrap"><img data-glow></span></a>';
    const img = document.querySelector('img')!;
    img.src = SRC;
    Object.defineProperty(img, 'complete', { value: true });
    Object.defineProperty(img, 'naturalWidth', { value: 80 });
    return document.querySelector<HTMLElement>('.store-card')!;
  }
  /** Seed the cache, then run a FRESH copy of the module against it. The module
   *  reads sessionStorage once and memoises in a closure — correct for a page
   *  load, but it would make these cases leak into each other. */
  async function glowAfter(stored: string): Promise<string> {
    sessionStorage.clear();
    sessionStorage.setItem('sn_store_glow', stored);
    const el = card();
    vi.resetModules();
    (await import('../src/scripts/store-glow.js')).initStoreGlow();
    await new Promise((r) => setTimeout(r, 0));
    return el.style.getPropertyValue('--store-glow');
  }

  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '';
  });

  it('applies a well-formed cached colour without re-reading the pixels', async () => {
    // jsdom has no canvas, so sampling cannot be what produced this — it can only
    // have come from the cache, which is exactly what the assertion is for.
    expect(await glowAfter(JSON.stringify({ [SRC]: '#b02c3b' }))).toBe('#b02c3b');
  });

  it('drops a cached value that is not a plain hex instead of writing it to the DOM', async () => {
    // sessionStorage is same-origin writable and outlives a format change between
    // builds. Without the shape check, anything here reaches setProperty.
    for (const poison of ['red;background:url(x)', 'var(--color-text)', '#fff', 42, null, { h: 1 }]) {
      const applied = await glowAfter(JSON.stringify({ [SRC]: poison }));
      expect(applied, String(poison)).toBe('');
    }
  });

  it('survives a corrupt cache entry rather than throwing on load', async () => {
    expect(await glowAfter('{not json')).toBe('');
  });
});

describe('wiring', () => {
  // `import.meta.url` is the jsdom document URL under this environment, not a
  // file path — resolve from the project root instead.
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
  const avatar = read('src/components/StoreAvatar.astro');
  const card = read('src/components/StoreCard.astro');
  const css = read('src/styles/components/store-card.css');

  it('tags the avatar for sampling ONLY when the URL is CORS-clean', () => {
    // `crossorigin` on a host that sends no ACAO header stops the image loading
    // altogether. If this guard ever goes, avatars break rather than lose a glow.
    expect(avatar).toContain('cdnIsSampleable(profileImage)');
    expect(cdnIsSampleable('/local/logo.png')).toBe(false);
    expect(cdnIsSampleable('https://res.cloudinary.com/demo/image/upload/v1/a.png')).toBe(true);
    expect(avatar).toMatch(/crossorigin=\{sampleable \? 'anonymous' : undefined\}/);
    expect(avatar).toMatch(/data-glow=\{sampleable \? '' : undefined\}/);
  });

  it('gives a store with no picture its mark hue server-side', () => {
    expect(card).toContain('--store-glow:${markGlow}');
    expect(card).toContain('store.profileImage ? undefined : storeMark(');
  });

  it('falls back to a light grey — never the accent — when the store colour is unknown', () => {
    // A blue halo on a black-and-white logo asserts a colour that store hasn't
    // got; grey is the honest "no colour found". Every use of the variable must
    // carry that fallback, so a new one can't quietly ship without a halo.
    const uses = css.match(/var\(--store-glow[^;]*?\)\)/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use).toContain('--color-muted');
      expect(use).not.toContain('--color-accent');
    }
  });
});
