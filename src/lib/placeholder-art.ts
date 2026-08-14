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
 *  Seven, and the rotation step is 1, because 7 is coprime with 2, 3 and 4 — the
 *  column counts `/stores`' grid uses. A pool of 4 (or a step sharing a factor)
 *  puts the same colour down an entire column at some viewport width. Any count
 *  coprime with all three works; five was the old one, and the set grew when red
 *  came out and the site's own navy, a sky and a slate went in (owner,
 *  2026-08-14 — a red invitation reads as a warning, not as a product).
 *
 *  Order is not alphabetical and not arbitrary: four of the seven are cool, so
 *  they are interleaved with the warm ones to keep row-neighbours apart.
 *
 *  ⚠️ `--color-invite-*`, NOT `--color-tile-*`. The tile tokens look like the
 *  obvious ones to reuse and are the wrong list: they are `MARK_HUES`, the
 *  palette every store's generated identity mark is built from, and a change
 *  here would have re-coloured every existing store. tokens.css carries both and
 *  says which is which.
 *
 *  Values are tokens, never hexes here. Two of them ARE brand colours now, which
 *  the first version avoided — but that rule was about a card built from three
 *  brand blues at once, which averaged to grey. One navy card standing between
 *  an orange one and a sky one is the opposite case.
 *
 *  `maxWash` is the deepest mix % of this hue the tile wash may reach, and it is
 *  PER HUE rather than one global cap, because equal percentages do not produce
 *  equal fill. The cap exists so the line-art — stroked in the same hue at full
 *  strength — keeps 3:1 against the deepest part of the wash behind it, and a
 *  dark low-chroma hue has far more room before it gets there than a light
 *  saturated one. With one cap of 22 for everybody, navy and slate washed out to
 *  almost nothing and their cards read as unfilled tiles, which is the "image
 *  failed to load" look this whole treatment exists to avoid.
 *
 *  Measured 2026-08-14, ratio of the hue against `color-mix(hue maxWash%, white)`:
 *  orange 3.14 · blue 3.87 · green 3.29 · gold 3.08 · navy 6.60 · sky 3.40 ·
 *  slate 3.63. Never raise one without re-measuring; 3:1 is the floor. */
export interface InviteHue {
  /** CSS custom property, declared in tokens.css. */
  token: string;
  /** Deepest mix % of this hue a tile wash may use. See above. */
  maxWash: number;
}

export const INVITE_HUES: readonly InviteHue[] = [
  { token: 'var(--color-invite-orange)', maxWash: 22 },
  { token: 'var(--color-invite-blue)', maxWash: 26 },
  { token: 'var(--color-invite-green)', maxWash: 22 },
  { token: 'var(--color-invite-gold)', maxWash: 22 },
  // 32, not the ~40 its contrast allows: at 38 the navy card was visibly heavier
  // than every other card in the row, which made it read as a different kind of
  // card rather than as the same card in another colour. The cap is a ceiling,
  // not a target.
  { token: 'var(--color-invite-navy)', maxWash: 32 },
  { token: 'var(--color-invite-sky)', maxWash: 22 },
  { token: 'var(--color-invite-slate)', maxWash: 34 },
];

/** Just the tokens, in order — the shape most callers and tests want. */
export const TILE_HUES: readonly string[] = INVITE_HUES.map((h) => h.token);

/** ONE light direction for every tile of every card (owner, 2026-08-14).
 *
 *  The first version gave each tile its own gradient angle — 145°, 215°, 175° —
 *  so within a single card the light appeared to come from three different
 *  directions at once. Three squares side by side, each lit from somewhere else,
 *  read exactly the way it was described: small pictures hung crooked. Nothing
 *  was geometrically tilted (the tiles are `aspect-ratio: 1`); the tilt was
 *  entirely in the lighting.
 *
 *  So the angle is a constant now, and it is the ONE thing the tiles no longer
 *  vary. 168° is very close to straight down with a slight lean — light from
 *  above, the way a product photograph is lit, and the lean keeps it from
 *  reading as a flat horizontal band. */
export const TILE_LIGHT_ANGLE = 168;

/** What separates the three tiles of one card, now that the angle can't: how
 *  deep the card's hue sinks into the surface. Every tile is lightest at the top
 *  and deepest at the bottom — a consistent ramp is what makes three tiles read
 *  as one lit scene, and the depth difference between them is what stops the
 *  card being a single flat block of colour.
 *
 *  These are FRACTIONS of the hue's own `maxWash`, not absolute mix percentages.
 *  Absolutes were the first version and they gave every hue the same numbers,
 *  which the navy and slate cards could not carry — see the note on INVITE_HUES.
 *  A fraction means the three tiles of a card always sit at the same three
 *  RELATIVE depths, whichever hue the card drew. */
export interface TileWash {
  /** Share of the hue's `maxWash` at the lit top edge. */
  top: number;
  /** …and at the shaded bottom edge. Always the deeper of the two. */
  bottom: number;
}

export const TILE_WASHES: readonly TileWash[] = [
  { top: 0.18, bottom: 1 },
  { top: 0.09, bottom: 0.68 },
  { top: 0.27, bottom: 0.95 },
];

/** Mix % for one tile edge, rounded — a fraction of the card hue's own budget. */
function washPercent(hue: InviteHue, fraction: number): number {
  return Math.round(hue.maxWash * fraction * 10) / 10;
}

/**
 * The full CSS `background` for one tile of the card at `cardIndex`: the wash,
 * under a soft highlight that falls from just above the tile's top edge.
 *
 * The highlight is what gives the tile a surface instead of a fill — it is the
 * same light the gradient ramps away from, so the two are one treatment rather
 * than the "gradients-on-gradients" store-card.css warns against. It is
 * deliberately weak and stops well before the middle: past that it turns the
 * tile into a glossy button, which is a 2010 treatment and not this site's.
 *
 * Takes the CARD index rather than a hue string, because the wash depth is a
 * property of the hue and the two must not be picked apart — the whole reason
 * the caps are per-hue is that a hue and its budget belong together.
 */
export function tileBackground(cardIndex: number, tileIndex: number): string {
  const hue = pickCardHueSpec(cardIndex);
  const wash = TILE_WASHES[tileIndex % TILE_WASHES.length]!;
  return [
    `radial-gradient(120% 78% at 50% -12%, color-mix(in srgb, #fff 55%, transparent) 0%, transparent 62%)`,
    `linear-gradient(${TILE_LIGHT_ANGLE}deg,`
      + ` color-mix(in srgb, ${hue.token} ${washPercent(hue, wash.top)}%, var(--color-surface)) 0%,`
      + ` color-mix(in srgb, ${hue.token} ${washPercent(hue, wash.bottom)}%, var(--color-surface)) 100%)`,
  ].join(', ');
}

/** The hairline that closes the tile off from the card behind it. A wash with no
 *  edge floats; the edge is what makes three of them read as a deliberate set —
 *  and it is drawn in the card's own hue, not the grey border token, so it
 *  belongs to the tile rather than outlining it. Scaled by the same budget: on a
 *  hue whose wash runs deep, a 12% edge disappears into it. */
export function tileEdge(cardIndex: number): string {
  const hue = pickCardHueSpec(cardIndex);
  return `inset 0 0 0 1px color-mix(in srgb, ${hue.token} ${washPercent(hue, 0.55)}%, transparent)`;
}

/** The full hue spec of the card at `cardIndex` — token plus its wash budget. */
export function pickCardHueSpec(cardIndex: number): InviteHue {
  return INVITE_HUES[cardIndex % INVITE_HUES.length]!;
}

/** The dominant hue of the card at `cardIndex`, as a CSS value. */
export function pickCardHue(cardIndex: number): string {
  return pickCardHueSpec(cardIndex).token;
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
