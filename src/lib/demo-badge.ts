/**
 * The "מוצר לדוגמה" badge — one source, every surface that can show a showcase product.
 *
 * **Why it is a module and not four copies.** The disclosure rule in `lib/demo-stores.ts` is that a
 * shopper must never learn a store was a demo only at the checkout refusal. That rule is only as
 * good as the surface that forgets it, and the badge was living as two hand-written copies (a class
 * string plus an inline SVG on the store page, a second inline SVG on the product page) with the
 * client-side card renderer holding a third copy of the same SVG. Two of the three had already
 * drifted in icon size. A surface added later — the homepage tiles, site search, either product
 * modal — got nothing at all, which is the failure this fixes.
 *
 * Isomorphic and string-returning, exactly like `price-html.ts` and for the same reason: the store
 * page renders these cards server-side AND rebuilds them in the browser for "load more", and the
 * two modals build their whole body with `innerHTML`. One spelling that runs in both places is
 * what keeps a client-rendered card from quietly dropping the disclosure.
 *
 * The label is passed IN rather than read here: this module is pure and has no `Astro.cookies` to
 * get a language from. `ProductDemoBadge.astro` is the component wrapper that supplies
 * `t.demo.productBadge`; a client renderer reads the same string off a `data-` attribute.
 */

import { escapeHtml } from './html-escape.js';

/**
 * `chip` — the overlay on a product card's image. `inline` — a line of muted text above the
 * product's name, used where the badge sits in normal flow (the product page, both modals).
 *
 * They are two variants and not one because a chip over a photograph needs its own backdrop to
 * stay readable, and a badge in a text column that carried one would read as a button.
 */
export type DemoBadgeVariant = 'chip' | 'inline';

/**
 * The chip's position and finish.
 *
 * Bottom inline-start is the one free corner: the wishlist heart owns top inline-end, the image
 * dots own bottom centre, and the sale badge owns top inline-start. It is ABSOLUTE on purpose —
 * an in-flow badge made the same product card taller in a showcase store than in a real one, so
 * the disclosure was quietly redesigning the grid. Every call site therefore has to place it
 * inside a positioned image wrapper (all four are `position:relative` already).
 *
 * `start-*`, NOT `inset-inline-start-*` — the latter is not a Tailwind utility at all, so it
 * compiled to nothing and the chip sat flush against the edge (owner, 2026-08-13). `start-` is the
 * logical-property utility and mirrors under `dir=rtl` for free.
 *
 * Opaque-ish white rather than a blurred glass chip, matching the heart's own treatment (memory
 * `feedback_wishlist_heart_no_glass`), and `pointer-events:none` so it can never swallow a click
 * meant for the card behind it.
 */
// `product-demo-chip` carries no styles of its own — it is the hook the image dots need in order
// to get out of this chip's way (store.css, `.product-card__dots:has(~ .product-demo-chip)`).
// The corner map in the comment above was right about which corners are OWNED and wrong about
// one thing: bottom CENTRE is not a point, it is a pill ~66px wide, and on a phone-width card
// it reaches into the start corner and covers this badge. Measured 2026-08-18: they overlap at
// every viewport 500px and under, i.e. on every phone, and the disclosure read "מוצר לד...".
// A marker class rather than a `:has()` on the wrapper because four surfaces render this chip
// and they do not all share a wrapper class.
const CHIP_CLASS = 'product-demo-chip absolute bottom-2 start-2 z-[2] pointer-events-none '
  + 'inline-flex items-center gap-1 py-[0.15rem] px-[0.4rem] rounded-[var(--radius-sm)] '
  + 'bg-white/70 [backdrop-filter:blur(4px)] text-[0.6rem] font-medium leading-[1.4] '
  + 'whitespace-nowrap [color:var(--color-muted)]';

/** Muted text, no box: in a text column the words are the whole point and a pill would compete
 *  with the product name directly under it. */
const INLINE_CLASS = 'inline-flex items-center gap-1 mb-1.5 text-[0.72rem] font-medium '
  + 'leading-[1.5] whitespace-nowrap [color:var(--color-muted)]';

export const DEMO_BADGE_CLASS: Record<DemoBadgeVariant, string> = {
  chip: CHIP_CLASS,
  inline: INLINE_CLASS,
};

/** The same information-circle `StoreDemoBadge` uses — the two say the same thing about the same
 *  store, so they must not be two different marks. */
function iconSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" `
    + `style="flex-shrink:0"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6v.6"/></svg>`;
}

/**
 * The badge, as HTML.
 *
 * `label` is escaped even though every caller passes a translation string: the escaping costs
 * nothing, and a helper whose safety depends on where its argument came from is one refactor away
 * from an injection (memory `project_attribute_escaping_xss`).
 */
export function demoProductBadgeHtml(label: string, variant: DemoBadgeVariant = 'chip'): string {
  return `<span class="${DEMO_BADGE_CLASS[variant]}">${iconSvg(variant === 'chip' ? 10 : 11)}${escapeHtml(label)}</span>`;
}
