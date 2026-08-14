import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LAUNCH_GRID_SLOTS,
  LAUNCH_MODE_MAX_STORES,
  LAUNCH_SLOTS,
  SHELF_INVITE_MAX_STORES,
  MIN_SHELF_DEMO,
  MIN_SHELF_INVITES,
  isLaunchMode,
  launchInviteCount,
  planLaunchShelf,
  showShelfInvite,
} from '../src/lib/launch-mode.js';
import {
  PLACEHOLDER_ART,
  TILE_HUES,
  TILE_WASHES,
  TILE_LIGHT_ANGLE,
  INVITE_HUES,
  tileBackground,
  pickArtTrio,
  pickCardHue,
  pickCardInk,
} from '../src/lib/placeholder-art.js';

describe('launch-mode thresholds', () => {
  it('is on below the store threshold and off at/above it', () => {
    expect(isLaunchMode(0)).toBe(true);
    expect(isLaunchMode(LAUNCH_MODE_MAX_STORES - 1)).toBe(true);
    expect(isLaunchMode(LAUNCH_MODE_MAX_STORES)).toBe(false);
    expect(isLaunchMode(50)).toBe(false);
  });

  it('shelf invite covers the thin phase only, never an empty site', () => {
    // 0 stores is launch mode's own job — a lone placeholder on an otherwise
    // blank page would be the "broken" state, not a fix for it.
    expect(showShelfInvite(0)).toBe(false);
    expect(showShelfInvite(1)).toBe(true);
    expect(showShelfInvite(SHELF_INVITE_MAX_STORES - 1)).toBe(true);
    expect(showShelfInvite(SHELF_INVITE_MAX_STORES)).toBe(false);
  });

  it('pads a row to a full set of slots, never negative', () => {
    expect(launchInviteCount(0)).toBe(LAUNCH_SLOTS);
    expect(launchInviteCount(3)).toBe(LAUNCH_SLOTS - 3);
    expect(launchInviteCount(LAUNCH_SLOTS)).toBe(0);
    expect(launchInviteCount(LAUNCH_SLOTS + 4)).toBe(0);
  });

  it('takes an explicit slot count for the directory grid', () => {
    expect(launchInviteCount(0, LAUNCH_GRID_SLOTS)).toBe(LAUNCH_GRID_SLOTS);
    expect(launchInviteCount(2, LAUNCH_GRID_SLOTS)).toBe(LAUNCH_GRID_SLOTS - 2);
  });

  it('grid slot count divides evenly by every column count the grid can use', () => {
    // Otherwise the last row ends with a single orphan card at some viewport width.
    for (const columns of [2, 3, 4]) expect(LAUNCH_GRID_SLOTS % columns).toBe(0);
  });

  it('…and that column list is the one the CSS can actually produce', () => {
    // The list above is hand-written, which makes it a claim about a file it does not read.
    // Widening the grid's minimum on 2026-08-05 (240 → 280, four cards to three) moved that
    // number without anything checking it — and lowering it instead is what would let a FIFTH
    // column appear, where 12 leaves two orphans on the last row. Derived from the CSS itself so
    // the next change to either side has to agree with this one.
    const css = readFileSync(join(process.cwd(), 'src/styles/pages/stores.css'), 'utf8');
    const tokens = readFileSync(join(process.cwd(), 'src/styles/base/tokens.css'), 'utf8');
    const minTrack = Number(/\.stores-directory__grid\s*\{[^}]*minmax\((\d+)px/.exec(css)![1]);
    const gap = Number(/\.stores-directory__grid\s*\{[^}]*gap:\s*([\d.]+)rem/.exec(css)![1]) * 16;
    const maxWidth = Number(/--max-width:\s*(\d+)px/.exec(tokens)![1]);
    // No page padding subtracted — an upper bound on the columns, so a pass here is a pass on
    // the real, narrower container too.
    const maxColumns = Math.floor((maxWidth + gap) / (minTrack + gap));
    expect(maxColumns).toBeGreaterThan(1);
    for (let columns = 1; columns <= maxColumns; columns++) {
      expect(LAUNCH_GRID_SLOTS % columns, `${columns} columns leaves an orphan row`).toBe(0);
    }
  });

  it('shelf slot count is even — the shelf is a 2-column grid on mobile', () => {
    expect(LAUNCH_SLOTS % 2).toBe(0);
  });
});

describe('placeholder art', () => {
  it('gives three distinct pieces per card', () => {
    const trio = pickArtTrio(0);
    expect(trio).toHaveLength(3);
    expect(new Set(trio.map((a) => a.id)).size).toBe(3);
  });

  it('varies between neighbouring cards', () => {
    expect(pickArtTrio(0).map((a) => a.id)).not.toEqual(pickArtTrio(1).map((a) => a.id));
  });

  it('is deterministic — the same card renders the same art', () => {
    expect(pickArtTrio(4).map((a) => a.id)).toEqual(pickArtTrio(4).map((a) => a.id));
  });

  it('stays in range for any index, including a full grid', () => {
    for (let i = 0; i < LAUNCH_GRID_SLOTS * 3; i++) {
      expect(pickArtTrio(i).every((a) => !!a && !!a.paths)).toBe(true);
    }
  });

  it('has unique ids and enough art to fill three distinct slots', () => {
    expect(new Set(PLACEHOLDER_ART.map((a) => a.id)).size).toBe(PLACEHOLDER_ART.length);
    expect(PLACEHOLDER_ART.length).toBeGreaterThanOrEqual(3);
  });
});

describe('placeholder tile colour', () => {
  it('gives one dominant hue per card, not per tile', () => {
    expect(pickCardHue(3)).toBe(TILE_HUES[3]);
    expect(pickCardHue(TILE_HUES.length)).toBe(TILE_HUES[0]);
  });

  it('rotates on a cycle coprime with every grid column count', () => {
    // A pool sharing a factor with the column count repeats one colour straight
    // down a whole column of the /stores grid at that viewport width.
    for (const columns of [2, 3, 4]) {
      const seen = new Set<string>();
      for (let row = 0; row < TILE_HUES.length; row++) seen.add(pickCardHue(row * columns));
      expect(seen.size).toBe(TILE_HUES.length);
    }
  });

  it('draws every hue from an INVITE token, never a literal colour or a mark hue', () => {
    // `--color-tile-*` is a different palette with the same shape: it is MARK_HUES,
    // what every store's generated identity mark is built from (store-mark.ts), and
    // reaching for it here would tie the invitation's colours to every existing
    // store's identity. tokens.css carries both lists and says which is which.
    for (const hue of TILE_HUES) expect(hue).toMatch(/^var\(--color-invite-[a-z]+\)$/);
  });

  it('declares every invite hue and ink it uses in tokens.css', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/base/tokens.css'), 'utf8');
    const declared = new Set([...css.matchAll(/--color-[a-z-]+(?=:)/g)].map((m) => m[0]));
    for (let i = 0; i < INVITE_HUES.length; i++) {
      expect(declared).toContain(pickCardHue(i).slice(4, -1));
      // An ink must be a declared token too, and never a literal colour.
      expect(pickCardInk(i)).toMatch(/^var\(--color-[a-z-]+\)$/);
      expect(declared).toContain(pickCardInk(i).slice(4, -1));
    }
  });

  it('inks the art in the card\'s own hue unless that hue cannot carry it', () => {
    // One colour per card is the rule, and yellow is the single exception: it is
    // too light to be stroked on top of itself at 3:1. Anything else reaching for
    // an ink means the card has stopped reading as one object.
    const split = INVITE_HUES.filter((h) => h.ink && h.ink !== h.token);
    expect(split.map((h) => h.token)).toEqual(['var(--color-invite-yellow)']);
    // And every other card's art IS its wash colour.
    for (let i = 0; i < INVITE_HUES.length; i++) {
      if (INVITE_HUES[i]!.ink) continue;
      expect(pickCardInk(i)).toBe(pickCardHue(i));
    }
  });

  it('keeps every card pale — no inverted tile in the set', () => {
    // A dark tile with white art was tried for the neutral slot and rejected as
    // an outlier in a row of pale cards (owner, 2026-08-14). Every ramp starts
    // near white, so a card that renders dark end to end means the rule slipped.
    for (let card = 0; card < INVITE_HUES.length; card++) {
      for (let tile = 0; tile < TILE_WASHES.length; tile++) {
        const mixes = [...tileBackground(card, tile).matchAll(/invite-[a-z]+\) ([\d.]+)%/g)]
          .map((m) => Number(m[1]));
        // 15 is nowhere near an inversion (that card started at 78) and leaves
        // room for the deepest hue's own lit edge, which lands at 10.3.
        expect(Math.min(...mixes)).toBeLessThanOrEqual(15);
      }
    }
  });

  it('keeps the three colours the owner ruled out, out', () => {
    // Each was removed for its own reason and none of them is aesthetic drift:
    // RED because a red wash on a card that is asking for something reads as a
    // warning; GREY because on a wash it is barely a colour and the card reads as
    // unfilled; VIOLET because it is the signature of AI-generated apps and reads
    // as an untrustworthy product (owner, 2026-08-14). The muted slots are greens
    // — sage — which is a green-grey, and still a colour.
    for (const hue of TILE_HUES) {
      expect(hue).not.toMatch(/red|grey|gray|slate|violet|purple|plum|indigo/);
    }
  });

  it('keeps the two look-alike pairs three slots apart', () => {
    // Two pairs sit close enough at a pale wash to be mistaken for each other:
    // the greens, and the two warm-pales. Three apart is the widest a seven-cycle
    // allows, so neither pair can land side by side in a row or stacked in a
    // column of the directory grid.
    const PAIRS = [/green|sage/, /orange|rose/];
    for (const pair of PAIRS) {
      const at = TILE_HUES.map((h, i) => (pair.test(h) ? i : -1)).filter((i) => i >= 0);
      expect(at).toHaveLength(2);
      const gap = Math.abs(at[0]! - at[1]!);
      expect(Math.min(gap, TILE_HUES.length - gap)).toBe(3);
    }
    // The greens also differ in depth, which is what carries them where the
    // ordering cannot — a shopper scrolling sees them at different distances.
    const greens = INVITE_HUES.filter((h) => /green|sage/.test(h.token));
    expect(new Set(greens.map((h) => h.maxWash)).size).toBe(greens.length);
  });

  it('keeps every tile wash inside its own hue\'s budget', () => {
    // Art is stroked in the card's hue at full strength, and the cap is what keeps
    // 3:1 between the two. It is per-hue because equal percentages are not equal
    // fill — see the note on INVITE_HUES for the measured ratios.
    expect(TILE_WASHES).toHaveLength(3);
    for (const w of TILE_WASHES) {
      expect(w.bottom).toBeLessThanOrEqual(1);
      expect(w.top).toBeLessThan(w.bottom);
      expect(w.top).toBeGreaterThan(0);
    }
    // Tiles must actually differ, or the card is one flat block of colour.
    expect(new Set(TILE_WASHES.map((w) => `${w.top}/${w.bottom}`)).size).toBe(TILE_WASHES.length);
    // And no hue's budget may drift past what the measurements cover. The ceiling
    // is where the darkest, least saturated hue in the set sits; past it a card
    // stops being a tinted tile and starts being a coloured block.
    for (const hue of INVITE_HUES) {
      expect(hue.maxWash).toBeGreaterThanOrEqual(22);
      expect(hue.maxWash).toBeLessThanOrEqual(38);
    }
  });

  it('never renders a wash deeper than the hue it belongs to allows', () => {
    for (let card = 0; card < INVITE_HUES.length; card++) {
      const cap = INVITE_HUES[card]!.maxWash;
      for (let tile = 0; tile < TILE_WASHES.length; tile++) {
        const mixes = [...tileBackground(card, tile).matchAll(/invite-[a-z]+\) ([\d.]+)%/g)]
          .map((m) => Number(m[1]));
        expect(mixes).toHaveLength(2);
        for (const mix of mixes) expect(mix).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('lights every tile from the same direction', () => {
    // The regression: three tiles with three gradient angles read as small
    // pictures hung crooked (owner, 2026-08-14). Light direction is a constant,
    // and depth is the only thing a tile is allowed to vary.
    const angles = TILE_WASHES.map((_, i) => tileBackground(0, i))
      .map((bg) => bg.match(/linear-gradient\((\d+)deg/)?.[1]);
    expect(new Set(angles).size).toBe(1);
    expect(angles[0]).toBe(String(TILE_LIGHT_ANGLE));
  });

  it('ramps every tile lighter at the top than at the bottom', () => {
    // A tile lit from below would pass the "one angle" test above and still look
    // wrong, so the ramp direction is pinned separately: the first colour stop
    // of the wash is always the weaker mix.
    for (let card = 0; card < INVITE_HUES.length; card++) {
      for (let tile = 0; tile < TILE_WASHES.length; tile++) {
        const stops = [...tileBackground(card, tile).matchAll(/invite-[a-z]+\) ([\d.]+)%/g)]
          .map((m) => Number(m[1]));
        expect(stops).toHaveLength(2);
        expect(stops[0]!).toBeLessThan(stops[1]!);
      }
    }
  });
});

describe('planLaunchShelf', () => {
  const real = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
  const demo = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);

  it('never fills every slot with stores — the invitation always survives', () => {
    // The regression this exists for: 3 real + 3 showcase stores is exactly
    // LAUNCH_SLOTS, and the "your store here" card silently disappeared while
    // launch mode was still on.
    const plan = planLaunchShelf(real(3), demo(3));
    expect(plan.invites).toBeGreaterThanOrEqual(MIN_SHELF_INVITES);
    expect(plan.stores.length + plan.invites).toBe(LAUNCH_SLOTS);
  });

  it('keeps a showcase store on the shelf even when real stores could fill it', () => {
    // 4 real stores is the most launch mode allows; one showcase store still shows.
    const plan = planLaunchShelf(real(4), demo(3));
    expect(plan.stores.filter((s) => s.startsWith('d')).length).toBeGreaterThanOrEqual(MIN_SHELF_DEMO);
    expect(plan.invites).toBeGreaterThanOrEqual(MIN_SHELF_INVITES);
  });

  it('gives real stores the remaining room ahead of showcase ones', () => {
    const plan = planLaunchShelf(real(4), demo(3));
    expect(plan.stores.filter((s) => s.startsWith('r'))).toHaveLength(4);
  });

  it('drops to ONE showcase store as soon as the mall has real ones', () => {
    // The shelf scrolls horizontally and shows roughly four and a half cards, so
    // 2 real + 3 showcase + 1 placeholder buried the placeholder off-screen —
    // the exact card the row exists to show.
    const plan = planLaunchShelf(real(2), demo(3));
    expect(plan.stores.filter((s) => s.startsWith('d'))).toHaveLength(1);
    expect(plan.stores).toHaveLength(3);
    expect(plan.invites).toBe(LAUNCH_SLOTS - 3);
  });

  it('always shows at least one of each — real, showcase and an open slot', () => {
    for (let r = 1; r < LAUNCH_MODE_MAX_STORES; r++) {
      const plan = planLaunchShelf(real(r), demo(3));
      expect(plan.stores.some((s) => s.startsWith('r'))).toBe(true);
      expect(plan.stores.some((s) => s.startsWith('d'))).toBe(true);
      expect(plan.invites).toBeGreaterThanOrEqual(1);
    }
  });

  it('orders real stores first, then showcase, so placeholders close the row', () => {
    const plan = planLaunchShelf(real(2), demo(2));
    const firstDemo = plan.stores.findIndex((s) => s.startsWith('d'));
    const lastReal = plan.stores.map((s) => s.startsWith('r')).lastIndexOf(true);
    expect(firstDemo).toBeGreaterThan(lastReal);
  });

  it('day one — showcase stores plus a padded row', () => {
    const plan = planLaunchShelf([], demo(3));
    expect(plan.stores).toHaveLength(3);
    expect(plan.stores.length + plan.invites).toBe(LAUNCH_SLOTS);
  });

  it('degrades to all placeholders when the showcase seeder never ran', () => {
    const plan = planLaunchShelf([], []);
    expect(plan.stores).toHaveLength(0);
    expect(plan.invites).toBe(LAUNCH_SLOTS);
  });

  it('never exceeds the slot count at any real/showcase mix', () => {
    for (let r = 0; r <= LAUNCH_MODE_MAX_STORES; r++) {
      for (let d = 0; d <= 5; d++) {
        const plan = planLaunchShelf(real(r), demo(d));
        expect(plan.stores.length + plan.invites).toBeLessThanOrEqual(LAUNCH_SLOTS);
        expect(plan.invites).toBeGreaterThanOrEqual(MIN_SHELF_INVITES);
      }
    }
  });
});
