/**
 * Soft product line-art for placeholder store cards (see launch-mode.ts).
 *
 * Deliberately eclectic and unlabelled — a shirt next to a lamp next to a
 * camera. The mall doesn't claim a category mix it doesn't have, and it never
 * tells a seller which field the slot is "for": any store fits anywhere. The
 * art is the whole message; there is no segment name anywhere in the UI.
 *
 * Each entry is the INNER markup of a 24×24 `viewBox` SVG (paths only) — the
 * component supplies the `<svg>` wrapper, stroke and colour, so all of it stays
 * `currentColor` + one stroke width and reads as one soft set.
 */

export interface PlaceholderArt {
  id: string;
  /** Inner SVG markup, 24×24 viewBox, stroke-based (no fills, no colours). */
  paths: string;
}

export const PLACEHOLDER_ART: readonly PlaceholderArt[] = [
  { id: 'shirt',      paths: '<path d="M9 4 5.5 5.8 4 9l2.5 1.2V20h11v-9.8L20 9l-1.5-3.2L15 4a3 3 0 0 1-6 0Z"/>' },
  { id: 'mug',        paths: '<path d="M4.5 7h10.5v9a3 3 0 0 1-3 3H7.5a3 3 0 0 1-3-3Z"/><path d="M15 10h2a2.5 2.5 0 0 1 0 5h-2"/>' },
  { id: 'headphones', paths: '<path d="M4.5 14.5v-2.5a7.5 7.5 0 0 1 15 0v2.5"/><rect x="2.5" y="13.5" width="4" height="6" rx="2"/><rect x="17.5" y="13.5" width="4" height="6" rx="2"/>' },
  { id: 'plant',      paths: '<path d="M6.5 13h11l-1 7.5h-9Z"/><path d="M12 13V8.5"/><path d="M12 9.5c0-2.6 2-4.6 4.6-4.6C16.6 7.5 14.6 9.5 12 9.5Z"/><path d="M12 11.5c0-2-1.6-3.6-3.6-3.6C8.4 9.9 10 11.5 12 11.5Z"/>' },
  { id: 'sneaker',    paths: '<path d="M3 12h3.5l2 2H12l3.5 2.2 4.2 1.1a2 2 0 0 1 1.3 1.9V20H3Z"/><path d="M3 16.5h18"/>' },
  { id: 'lamp',       paths: '<path d="M8.5 4h7l3.5 6.5H5Z"/><path d="M12 10.5V20"/><path d="M9 20h6"/>' },
  { id: 'book',       paths: '<path d="M6 3.5h11a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"/><path d="M4 17.5h14"/>' },
  { id: 'camera',     paths: '<path d="M3.5 7.5h4L9 5.5h6l1.5 2h4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/>' },
  { id: 'bag',        paths: '<path d="M5.5 8h13l1 12h-15Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>' },
  { id: 'watch',      paths: '<circle cx="12" cy="12" r="5"/><path d="M9 7.2 9.5 3h5l.5 4.2"/><path d="M9 16.8 9.5 21h5l.5-4.2"/>' },
  { id: 'bottle',     paths: '<path d="M10 3h4v3.2l1.6 2.6V20a1 1 0 0 1-1 1H9.4a1 1 0 0 1-1-1V8.8L10 6.2Z"/><path d="M8.4 12.5h7.2"/>' },
  { id: 'chair',      paths: '<path d="M6.5 4h11v9h-11Z"/><path d="M4.5 13h15"/><path d="M7.5 13v7M16.5 13v7"/>' },
];

/** One dominant hue per CARD (not per tile — that was the first version, and
 *  rotating the brand blues/teals across a card's three tiles averaged out to a
 *  flat grey card). All three tiles of a card share the hue, so each store slot
 *  has one clear colour identity, and the row gets its variety from card to card
 *  instead of from tile to tile.
 *
 *  Five, and the rotation step is 1, because 5 is coprime with 2, 3 and 4 — the
 *  column counts `/stores`' grid uses. A pool of 4 (or a step sharing a factor)
 *  puts the same colour down an entire column at some viewport width.
 *
 *  Values are tokens (`tokens.css`), never hexes here — and they are deliberately
 *  vivid rather than brand colours. The consumer mixes the hue down to a wash for
 *  the tile background and draws the line-art in the hue at full strength. */
export const TILE_HUES: readonly string[] = [
  'var(--color-tile-blue)',
  'var(--color-tile-orange)',
  'var(--color-tile-green)',
  'var(--color-tile-gold)',
  'var(--color-tile-red)',
];

/** The only thing that separates the three tiles of one card: gradient angle and
 *  how much of the card's hue washes into white. `from` never exceeds 22 — the
 *  line-art is drawn in the same hue, and past that the two collapse into each
 *  other (22% is where the weakest token, gold, still clears 3:1). */
export interface TileWash {
  angle: number;
  /** Mix % of the hue at the gradient's strong end. */
  from: number;
  /** Mix % at the weak end. */
  to: number;
}

export const TILE_WASHES: readonly TileWash[] = [
  { angle: 145, from: 20, to: 6 },
  { angle: 215, from: 12, to: 4 },
  { angle: 175, from: 22, to: 8 },
];

/** The dominant hue of the card at `cardIndex`. */
export function pickCardHue(cardIndex: number): string {
  return TILE_HUES[cardIndex % TILE_HUES.length]!;
}

/** Step between one card's starting art and the next card's. Must be coprime
 *  with the pool size so the sequence visits every piece before repeating —
 *  a step of 3 against 12 pieces cycles every 4 cards, which in a 4-column
 *  grid put an identical trio down every single column (seen, then fixed).
 *  5 is also > 2, so adjacent cards share no art at all. */
const ART_STEP = 5;

/**
 * `count` different pieces of art for the card at `cardIndex`, walking the pool so
 * neighbouring cards never repeat the same set. Deterministic (no randomness) —
 * the shelf renders server-side and must be stable across a re-render.
 */
export function pickArtTrio(cardIndex: number, count: number = 3): PlaceholderArt[] {
  const start = (cardIndex * ART_STEP) % PLACEHOLDER_ART.length;
  return Array.from({ length: count }, (_, offset) => PLACEHOLDER_ART[(start + offset) % PLACEHOLDER_ART.length]!);
}
