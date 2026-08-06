---
name: project-checkout-ui
description: "Checkout page UI architecture — PQV modal, patchQty, stock enforcement, button colors"
metadata: 
  node_type: memory
  type: project
  originSessionId: 693d6806-f228-4452-8f9b-7fbbb2d27fc8
  modified: 2026-07-30T06:38:57.237Z
---

Checkout page (`src/pages/checkout.astro`) was fully redesigned and polished.

**Key patterns:**
- `patchQty(card, storeSlug, cartKey)` — surgical DOM update on +/− clicks; never calls `renderCart()` for qty changes (avoids card shadow flicker from innerHTML replacement)
- `renderCart()` — called only on initial load and after item removal
- PQV (Product Quick View) — native `<dialog showModal()>` stacked above main dialog; product cache `Map<string, PQVProduct>` for instant re-open; lightbox also native `<dialog showModal()>` above PQV
- Global ripple delegation excludes: `.co-qty__btn`, `.pqv-qty-btn`, `.pqv-trigger`, `.co-card__name`

**Button color system:**
- `btn` base = dark teal-green gradient `#2a3c40 → #3a5260` (add-to-cart buttons)
- `btn--accent` = blue gradient `var(--color-accent) → #6088d4` (checkout CTAs: "לתשלום", "בצע הזמנה")
- `btn--ghost` = transparent with border (secondary actions)

**Stock enforcement — all qty steppers:**
- Cart cards in checkout: disabled attr set in `renderCart()` HTML + click guard in handler
- CartDrawer: `data-stock` on + button; handler checks + disables/enables in-place
- Store page grid stepper: `updateQty()` disables `qty-inc` at maxStock; `disabled:opacity-30` class on button
- All disabled styles: `opacity: 0.35` + `cursor: default` — the `not-allowed` cursor written here originally is now BANNED site-wide (AI_INSTRUCTIONS.md → Micro-interactions, enforced by a `reset.css` rule on `:disabled`); don't copy it from this memory
- A line that ran out mid-checkout is corrected on the card rather than refused: see [[project_stock_shortage_ux]]

**Why:** avoid re-render flicker, keep interactions snappy, enforce stock everywhere consistently.
