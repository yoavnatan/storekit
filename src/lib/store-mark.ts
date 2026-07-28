/**
 * Deterministic visual identity for a store, derived from its slug alone.
 *
 * Every store has one of these from the second it is created — a seller who
 * never uploads a profile image still has a stable, distinguishable mark, so no
 * surface anywhere (avatar, `og:image`, structured data, ad creative) is ever
 * left with an empty image. See store-image.ts for which surface picks the
 * uploaded image and which picks this.
 *
 * Two renderings, one identity: the site draws the mark in CSS/SVG (crisp, no
 * request), and `store-mark-raster.ts` draws the *same* gradient + grid as a
 * PNG for external consumers that can't take SVG. Both read from this file, so
 * a store looks the same in a search result and in a Facebook share card.
 *
 * Deterministic on purpose — no randomness, no stored state, nothing to
 * migrate. Renaming a store's slug changes its mark; that is the same event
 * that changes its URL, so it is not a surprise.
 */

/** Mirrors `--color-tile-*` in `tokens.css`. Duplicated as literals here (the
 *  one place the design-token rule can't hold) because a PNG has no cascade:
 *  the rasteriser needs real channel values. Keep the two lists in sync — the
 *  hexes are asserted against the stylesheet in `tests/store-image.test.ts`. */
export const MARK_HUES: readonly string[] = ['#2563c9', '#c2620d', '#158a56', '#a8760a', '#c33a2c'];

/** 5×5, mirrored left-to-right — so 15 independently-chosen cells. Symmetry is
 *  what keeps a random-looking pattern reading as a deliberate mark. */
export const MARK_GRID_SIZE = 5;
const FREE_CELLS = 15; // (MARK_GRID_SIZE / 2 rounded up) * MARK_GRID_SIZE

export interface StoreMark {
  /** Base hue (hex) — the store's colour identity. */
  hue: string;
  /** Gradient start (hex), top-start corner. */
  from: string;
  /** Gradient end (hex), bottom-end corner. */
  to: string;
  /** `MARK_GRID_SIZE²` cells, row-major; true = a filled block. */
  grid: readonly boolean[];
  /** First character of the store name, for the on-site avatar. */
  initial: string;
}

/** FNV-1a, 32-bit. Stable across processes and Node versions (a plain
 *  `hashCode`-style sum collides badly on same-length slugs). */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function clampChannel(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** Mix a hex colour toward white (`amount` > 0) or black (`amount` < 0). */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const target = amount > 0 ? 255 : 0;
  const k = Math.abs(amount);
  const out = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
    .map((c) => clampChannel(c + (target - c) * k))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('');
  return `#${out}`;
}

/** [r, g, b] channels of a hex colour — for the rasteriser. */
export function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function buildGrid(slug: string): boolean[] {
  // Hashed separately from the hue (which is `hash(slug) % 5`, i.e. low bits):
  // drawing both from one word would tie every blue store to a small family of
  // patterns instead of letting the two vary independently.
  const bits = hash(`${slug}#grid`);
  const half = Math.ceil(MARK_GRID_SIZE / 2);
  const cells: boolean[] = [];
  for (let i = 0; i < FREE_CELLS; i++) {
    cells.push(((bits >>> i) & 1) === 1);
  }
  // Guard both extremes: an all-off mark is an empty tile, an all-on one is a
  // solid block. Either loses the per-store distinction the mark exists for.
  const on = cells.filter(Boolean).length;
  if (on < 4 || on > FREE_CELLS - 4) {
    for (let i = 0; i < cells.length; i += 2) cells[i] = !cells[i];
  }

  const grid: boolean[] = [];
  for (let row = 0; row < MARK_GRID_SIZE; row++) {
    for (let col = 0; col < MARK_GRID_SIZE; col++) {
      const mirrored = col < half ? col : MARK_GRID_SIZE - 1 - col;
      grid.push(cells[row * half + mirrored]!);
    }
  }
  return grid;
}

/**
 * The mark for `seed` (always the store slug — stable, unique, and already the
 * store's identity everywhere else). `name` only supplies the avatar initial.
 */
export function storeMark(seed: string, name = ''): StoreMark {
  const h = hash(seed);
  const hue = MARK_HUES[h % MARK_HUES.length]!;
  return {
    hue,
    from: shade(hue, 0.12),
    to: shade(hue, -0.3),
    grid: buildGrid(seed),
    initial: (name.trim()[0] ?? seed.trim()[0] ?? '?').toUpperCase(),
  };
}

/** CSS value for the mark's background — the on-site half of the identity. */
export function storeMarkGradient(mark: StoreMark): string {
  return `linear-gradient(135deg, ${mark.from}, ${mark.to})`;
}
