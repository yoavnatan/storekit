import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The order-card header is rendered by THREE separate code paths — the seller
// dashboard's SSR markup, the client-side rebuilder that replaces the list after
// a sort/filter/page change, and the admin panel's platform-wide copy. They have
// to agree, and nothing at runtime notices when they stop: a card rebuilt by the
// client with last month's classes looks fine until the exact width where the
// old layout broke.
//
// It broke there (2026-07-31, owner report): below ~490px of card the header was
// a single flex row with a shrink-0 trailing column, so the age chip + status
// badge claimed their full 186px min-content beside the buyer name, the card's
// min width came out at 479px against a 343px viewport, and the buyer name was
// squeezed to LITERALLY zero — the whole card scrolled sideways with no order
// details visible at all. The fix is a container query on the card itself (not
// the viewport — the admin copy sits beside a sidebar, so viewport width says
// nothing about the room the card has): below 640px of card the header becomes a
// 3-column grid and the two wrappers go display:contents so their children place
// directly into it.
//
// So the contract this test pins is: all three renderers carry the same layout,
// and it is expressed as a CONTAINER query, never a viewport one.

const FILES = {
  'seller SSR': 'src/pages/seller/dashboard.astro',
  'client rebuild': 'src/scripts/dashboard/orders.ts',
  'admin panel': 'src/components/admin/AdminOrdersPanel.astro',
} as const;

const sources = Object.fromEntries(
  Object.entries(FILES).map(([name, path]) => [name, readFileSync(join(process.cwd(), path), 'utf8')]),
) as Record<keyof typeof FILES, string>;

/** The class list of the first element whose class attribute contains `marker`. */
function classesOf(src: string, marker: string): string {
  const m = src.match(new RegExp(`class(?:Name)?=["'\`]([^"'\`]*\\b${marker}\\b[^"'\`]*)["'\`]`));
  return m?.[1] ?? '';
}

describe('order card header layout', () => {
  it('makes the card its own container in every renderer', () => {
    for (const [name, src] of Object.entries(sources)) {
      expect(classesOf(src, 'order-card'), name).toContain('@container/ordcard');
    }
  });

  it('places all five header children explicitly in the narrow grid', () => {
    // Auto-placement would put the price where the chevron belongs, so each of
    // these must name its own cell. One assertion per cell, per renderer.
    const areas = ['[grid-area:1/1]', '[grid-area:1/2]', '[grid-area:1/3]', '[grid-area:2/1]', '[grid-area:2/2/3/4]'];
    for (const [name, src] of Object.entries(sources)) {
      for (const area of areas) expect(src, `${name} is missing ${area}`).toContain(area);
    }
  });

  it('collapses the two header wrappers with display:contents below the breakpoint', () => {
    // Without `contents` the grid sees two wrappers instead of five children and
    // the whole restructure is a no-op.
    for (const [name, src] of Object.entries(sources)) {
      const contentsWrappers = [...src.matchAll(/class(?:Name)?=["'`]contents @\[640px\]\/ordcard:flex/g)];
      expect(contentsWrappers.length, `${name} should have both wrappers on display:contents`).toBe(2);
    }
  });

  it('keys the desktop row off the CARD, never the viewport', () => {
    // A `sm:` on any of these elements is the bug this replaced: the admin copy
    // sits next to a sidebar, so 640px of viewport is not 640px of card.
    for (const [name, src] of Object.entries(sources)) {
      const header = classesOf(src, 'order-card__header');
      expect(header, `${name} header still keys off the viewport`).not.toMatch(/\bsm:/);
      expect(header, name).toContain('@[640px]/ordcard:flex');
      expect(classesOf(src, 'order-card__amount'), name).not.toMatch(/\bsm:/);
    }
  });

  it('lets the age chip yield and never the status badge', () => {
    // Measured worst real pair: "טרם נשלחה · N ימים" + note chip + "בטיפול" =
    // 210px. At the old 12rem (192px) slot the chip printed through the price;
    // 13.5rem clears it, and past that the chip's own slot clips instead.
    for (const [name, src] of Object.entries(sources)) {
      const slot = classesOf(src, 'order-age-chip-slot');
      expect(slot, `${name} chip slot must be able to shrink`).toContain('min-w-0');
      expect(slot, `${name} chip slot must clip rather than overrun the price`).toContain('overflow-hidden');
      expect(slot, `${name} chip slot must not be shrink-0`).not.toMatch(/\bshrink-0\b/);
      expect(classesOf(src, 'order-card__status-badge'), `${name} status badge must not shrink`).toContain('shrink-0');
      expect(src, `${name} status cluster width`).toContain('@[640px]/ordcard:w-[13.5rem]');
    }
  });

  it('clips the chip rather than squeezing its icon', () => {
    // The slot shrinks; the chip inside it must NOT, or the squeeze lands on the
    // 11px clock SVG instead of the text. Measured at the worst real pair: the
    // icon went to 0px wide — the same icon-squishing the owner caught once
    // before, arriving by a new route.
    const chip = readFileSync(join(process.cwd(), 'src/lib/order-age.ts'), 'utf8');
    const span = chip.match(/return `<span class="([^"]*)"/)?.[1] ?? '';
    expect(span, 'the age chip must be shrink-0').toContain('shrink-0');
  });
});
