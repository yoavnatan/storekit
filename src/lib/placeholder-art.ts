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
 *  Eleven, and the rotation step is 1, because 11 is coprime with 2, 3 and 4 — the
 *  column counts `/stores`' grid uses. A pool of 4 (or a step sharing a factor)
 *  puts the same colour down an entire column at some viewport width. Any count
 *  coprime with all three works (5, 7, 11 …), so a colour can be swapped freely
 *  but one cannot simply be added or dropped — which is why the owner's "one more
 *  shade" became four (tokens.css says it in full).
 *
 *  ⚠️ `--color-invite-*`, NOT `--color-tile-*`. The tile tokens look like the
 *  obvious ones to reuse and are the wrong list: they are `MARK_HUES`, the
 *  palette every store's generated identity mark is built from, and a change
 *  here would have re-coloured every existing store. tokens.css carries both and
 *  says which is which — along with the full history of what these seven are and
 *  why (red out, grey out, yellow made yellow, orange made redder).
 *
 *  Values are tokens, never hexes here.
 *
 *  `maxWash` is the deepest mix % of this hue the tile wash may reach, and it is
 *  PER HUE rather than one global cap, because equal percentages do not produce
 *  equal fill. The cap exists so the line-art keeps 3:1 against the deepest part
 *  of the wash behind it, and a dark hue has far more room before it gets there
 *  than a light one. With one cap of 22 for everybody the dark hues washed out to
 *  almost nothing and their cards read as unfilled tiles, which is the "image
 *  failed to load" look this whole treatment exists to avoid.
 *
 *  `ink` is the colour the line-art is stroked in, and it defaults to the hue
 *  itself — one colour per card is the rule, and ten of the eleven keep it. Yellow
 *  is the exception and had to be: the art used to BE the wash colour, which
 *  meant the only "yellows" that could pass 3:1 against themselves were the dark
 *  muddy ones, and that is why this slot was a gold that read as orange. Splitting
 *  the ink off is what let the wash become an actual yellow. Reach for it only for
 *  that reason — a card whose art is a different colour from its tiles stops
 *  reading as one object.
 *
 *  Contrast measured 2026-08-14, ink against `color-mix(hue maxWash%, white)`:
 *  orange 3.71 · clay 4.68 · blue 3.86 · indigo 5.46 · yellow 5.20 · sky 3.40 ·
 *  green 3.29 · fresh 3.85 · teal 3.54 · olive 3.81 · rose 4.01. Never raise a cap
 *  without re-measuring; 3:1 is the floor. */
export interface InviteHue {
  /** CSS custom property for the tile wash, declared in tokens.css. */
  token: string;
  /** Deepest mix % of this hue a tile wash may use. See above. */
  maxWash: number;
  /** Which corner of the wheel this hue sits in. Not decoration: it is what the
   *  ordering rule is enforced against — two cards from the same family may never
   *  be adjacent in the rotation, or they land side by side in a row. */
  family: 'warm' | 'yellow' | 'green' | 'blue';
  /** Line-art colour, when it cannot be the hue itself. Defaults to `token`. */
  ink?: string;
}

// The ORDER is the second half of the distinctness argument, and the one that
// does not show up in any single colour value. Eleven hues cannot all be far
// apart on the wheel — see tokens.css for why two of them are depth-variants of
// their neighbours rather than new angles — so what keeps a grid from looking
// repetitive is that no two cards of the same FAMILY are ever adjacent, and the
// four tightest pairs (orange/clay, green/fresh, green/teal, blue/indigo) sit at
// least three slots apart. Both are pinned by tests; the cycle below alternates
// warm → green → yellow → blue and repeats, which is what produces that.
export const INVITE_HUES: readonly InviteHue[] = [
  // YELLOW LEADS, and that is a decision rather than an accident of ordering
  // (owner, 2026-08-14): "הצהוב בהתחלה כן יפה, הוא מזמין גם לפעולה... זה צבע
  // חיובי". The first open slot a seller meets is the one being asked to act on,
  // so it gets the most positive colour in the set. Whatever else moves here,
  // slot 0 stays yellow.
  { token: 'var(--color-invite-yellow)', maxWash: 26, family: 'yellow', ink: 'var(--color-invite-yellow-ink)' },
  { token: 'var(--color-invite-sky)', maxWash: 22, family: 'blue' },
  { token: 'var(--color-invite-orange)', maxWash: 22, family: 'warm' },
  { token: 'var(--color-invite-green)', maxWash: 22, family: 'green' },
  // The muted green — olive rather than the emerald, and the slot that took four
  // tries: a slate grey, the site's dark navy, that navy inverted to a dark tile
  // with white art, then a grey-green sage. tokens.css carries the full record.
  { token: 'var(--color-invite-olive)', maxWash: 30, family: 'yellow' },
  { token: 'var(--color-invite-blue)', maxWash: 26, family: 'blue' },
  // The orange's own corner of the wheel, at 34% rather than 22%. Not a second
  // orange: at that depth it reads as clay, and its wash lands ~30 points darker
  // than the orange's on every channel.
  { token: 'var(--color-invite-clay)', maxWash: 34, family: 'warm' },
  // 137° — one of the only two genuinely free angles left, and deep enough that
  // it does not collapse into the emerald at 153°.
  { token: 'var(--color-invite-fresh)', maxWash: 34, family: 'green' },
  { token: 'var(--color-invite-rose)', maxWash: 26, family: 'warm' },
  // 175°, the second free angle. Deeper than the emerald on purpose — at 22% the
  // two were the same card, which is exactly why a teal was thrown out of the
  // seven-hue set.
  { token: 'var(--color-invite-teal)', maxWash: 30, family: 'green' },
  // The blue's own corner at 34%. Same argument as the clay.
  { token: 'var(--color-invite-indigo)', maxWash: 34, family: 'blue' },
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
 *  which the least saturated hues could not carry — see the note on INVITE_HUES.
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

/** The dominant hue of the card at `cardIndex`, as a CSS value — the tiles' wash. */
export function pickCardHue(cardIndex: number): string {
  return pickCardHueSpec(cardIndex).token;
}

/** The colour this card's line-art is stroked in — its hue, unless that hue is
 *  too light to be drawn on top of itself (see `ink` on InviteHue). */
export function pickCardInk(cardIndex: number): string {
  const hue = pickCardHueSpec(cardIndex);
  return hue.ink ?? hue.token;
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
