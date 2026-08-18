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
// four tightest pairs (orange/clay, green/fresh, green/teal, blue/indigo) are
// never side by side either. Both are pinned by tests.
//
// Three slots apart was the guarantee at seven hues and cannot survive eleven:
// four of these sit in the green corner, and four items in an 11-cycle whose
// other seven slots must also stay non-adjacent leave gaps of two. So the promise
// is two — no pair ever adjacent — and inside each tight pair the two differ in
// DEPTH, which is what tells them apart where the ordering runs out.
export const INVITE_HUES: readonly InviteHue[] = [
  // YELLOW LEADS, and that is a decision rather than an accident of ordering
  // (owner, 2026-08-14): "הצהוב בהתחלה כן יפה, הוא מזמין גם לפעולה... זה צבע
  // חיובי". The first open slot a seller meets is the one being asked to act on,
  // so it gets the most positive colour in the set. Whatever else moves here,
  // slot 0 stays yellow.
  { token: 'var(--color-invite-yellow)', maxWash: 26, family: 'yellow', ink: 'var(--color-invite-yellow-ink)' },
  // …AND THE TEAL IS SECOND (owner, 2026-08-14). This slot held the sky, then the
  // OLIVE — he wanted a green in the pair a seller sees first — and now the two
  // greens have simply traded places: he saw the teal card and asked for that one
  // here instead. The olive keeps the teal's old slot, so the set is unchanged and
  // only the order moved. Both are filed `green` rather than `yellow`: the olive is
  // a yellow-GREEN, and filing it under yellow is what would have made this pairing
  // illegal for no visual reason.
  { token: 'var(--color-invite-teal)', maxWash: 30, family: 'green' },
  { token: 'var(--color-invite-orange)', maxWash: 22, family: 'warm' },
  { token: 'var(--color-invite-green)', maxWash: 22, family: 'green' },
  { token: 'var(--color-invite-sky)', maxWash: 22, family: 'blue' },
  // The olive, moved down here when the teal took slot 1. The note that used to sit
  // on this line belongs to the teal above: 175° is one of the two genuinely free
  // angles, and it is deeper than the emerald on purpose — at 22% the two were the
  // same card, which is exactly why a teal was thrown out of the seven-hue set.
  { token: 'var(--color-invite-olive)', maxWash: 30, family: 'green' },
  // The orange's own corner of the wheel, at 34% rather than 22%. Not a second
  // orange: at that depth it reads as clay, and its wash lands ~30 points darker
  // than the orange's on every channel.
  { token: 'var(--color-invite-clay)', maxWash: 34, family: 'warm' },
  // 137° — the other free angle, and deep enough that it does not collapse into
  // the emerald at 153°.
  { token: 'var(--color-invite-fresh)', maxWash: 34, family: 'green' },
  { token: 'var(--color-invite-blue)', maxWash: 26, family: 'blue' },
  { token: 'var(--color-invite-rose)', maxWash: 26, family: 'warm' },
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

/** Mix % for one stop of the wash, rounded — a fraction of the card hue's own budget. */
function washPercent(hue: InviteHue, fraction: number): number {
  return Math.round(hue.maxWash * fraction * 10) / 10;
}

/**
 * ONE wash for the whole preview ROW, replacing the per-tile backgrounds (owner,
 * 2026-08-18: "לא על כל כרטיסיה בנפרד אלא כמו כולם ביחד", and a colour that "הופך
 * לשקוף לגמרי").
 *
 * The per-tile version was correct for what it was solving — four tiles that had to
 * stand in for four product photos — and it stopped being correct when the corner
 * radius went to 2px. At 10px the tile edges were soft enough to disappear; sharp,
 * the card became four hard rectangles inside a rectangle inside a grid, and the
 * eye counts every one of them. Painting the row instead of the tiles removes three
 * of those four boundaries without removing anything the card was saying.
 *
 * The gradient reaches FULLY transparent rather than fading into the surface. That
 * is the difference he asked for and it is not cosmetic: `color-mix(…, transparent)`
 * against `--color-surface` bottoms out at the card's own colour, so the wash always
 * ended on a visible edge somewhere. Ending at `transparent` means the card behind it
 * is what the wash resolves into, whatever that card is — so the same row works on
 * the surface, on the page background, and against a dark theme without a second set
 * of numbers.
 *
 * Same 168° and the same ramp DIRECTION as the tiles (TILE_LIGHT_ANGLE): transparent at
 * the lit top edge, deepest at the shaded bottom. That direction was tried inverted first
 * — colour at the top dissolving downward, which is the obvious reading of "fades to
 * transparent" — and it hung the band off the chips above it instead of grounding it.
 * Lit from above is not a preference here, it is the one property every tile shared, and
 * a row that reverses it stops being the same scene at a larger size.
 *
 * 0.3 -> 0.85 of the hue's own budget, not 0 -> 1: the deep end stays under the cap that
 * keeps the line-art at 3:1 against it (see INVITE_HUES), and the light end starts above
 * zero so the middle of the row is a colour rather than a fade with a stripe at the end.
 */
export function previewWash(cardIndex: number): string {
  const hue = pickCardHueSpec(cardIndex);
  return [
    `radial-gradient(90% 60% at 50% -8%, color-mix(in srgb, #fff 45%, transparent) 0%, transparent 58%)`,
    `linear-gradient(${TILE_LIGHT_ANGLE}deg,`
      + ` transparent 0%,`
      + ` color-mix(in srgb, ${hue.token} ${washPercent(hue, 0.3)}%, transparent) 45%,`
      + ` color-mix(in srgb, ${hue.token} ${washPercent(hue, 0.85)}%, transparent) 100%)`,
  ].join(', ');
}

/** The full hue spec of the card at `cardIndex` — token, wash budget, ink.
 *  Module-private on purpose: a caller that could take the spec apart could also
 *  pair a token with somebody else's cap, and the caps only mean anything attached
 *  to the hue they were measured against. */
function pickCardHueSpec(cardIndex: number): InviteHue {
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

/**
 * A SOLID fill from this palette, for a small filled shape rather than a washed tile.
 *
 * The reviewer's initial circle on a product page is the first caller (owner, 2026-08-17: he
 * pointed at the homepage invite cards and said use THAT palette). It needs the opposite of what a
 * tile needs — the tile is a pale wash the art is drawn ON, this is the hue at full strength with
 * white type on top — so it takes the token directly and ignores `maxWash` entirely, which is a
 * cap on the wash and means nothing here.
 *
 * `ink` is preferred where a hue declares one: that field exists precisely because two of these
 * are too light to carry their own line-art, and a light hue behind white text has the same
 * problem for the same reason.
 *
 * Keyed by an arbitrary STRING rather than a card index, because a review has no position in a
 * grid — the caller hashes whatever identity it wants stable (`hueIndexFor`).
 */
export function soloHue(index: number): string {
  const hue = INVITE_HUES[((index % INVITE_HUES.length) + INVITE_HUES.length) % INVITE_HUES.length]!;
  return hue.ink ?? hue.token;
}

/**
 * The same hue with DEPTH — a 135° gradient, lighter at the top-start corner.
 *
 * The angle and the direction are not invented here: `store-mark.ts` paints every store's identity
 * mark at 135° from `shade(hue, +0.12)` to `shade(hue, -0.30)`, and the invite tiles are lit from
 * the same corner (`TILE_LIGHT_ANGLE`). A round mark on this site is lit from the top-start, so one
 * that is not looks like a different site's control.
 *
 * `color-mix` rather than `shade()` because these hues are TOKENS, not hexes — the whole point of
 * `--color-invite-*` is that a value can move in `tokens.css` without a rebuild, and reading them
 * into JS to darken them would freeze the copy that got read. The two percentages are the same
 * distance the store mark travels, expressed the way CSS can do it.
 */
export function soloHueGradient(index: number): string {
  const hue = soloHue(index);
  return `linear-gradient(135deg,`
    + ` color-mix(in srgb, ${hue} 88%, #fff) 0%,`
    + ` color-mix(in srgb, ${hue} 70%, #000) 100%)`;
}

/**
 * Which of the eleven a given string lands on.
 *
 * FNV-1a, the same hash `store-mark.ts` uses and for the same reason: a plain character sum
 * collides badly across same-length seeds, which for reviewer initials would put every name of a
 * given length in the same handful of colours. Deterministic and stateless — nothing is stored, and
 * the same seed is the same colour forever.
 */
export function hueIndexFor(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % INVITE_HUES.length;
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
