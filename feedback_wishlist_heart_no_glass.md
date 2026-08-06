---
name: feedback-wishlist-heart-no-glass
description: "Tried glassmorphism on the card wishlist heart button to match the carousel dots — user rejected it, reverted to opaque white circle"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d793ae5f-e1dd-4f53-b9ce-47ef5cdb9574
---

The floating wishlist heart button on store-page product cards (`.wishlist-btn` in `[slug].astro`) stays a near-opaque white circle — `background: rgba(255,255,255,0.9)` (inactive) / `rgba(255,255,255,0.95)` (active/wishlisted), no `backdrop-filter`, no border. Tried matching it exactly to the glassmorphism formula used on the image-carousel dots pill (`rgba(255,255,255,0.15)` + `blur(8px)` + `0.75px` border) since the user asked for it — user tested it and said it looked worse on the heart specifically, reverted immediately (2026-07-07).

**Why:** Not fully diagnosed (user didn't elaborate beyond "less nice"), but plausibly: the dots pill is a group of small shapes where blur/translucency reads as an ambient container, while the heart is a single glyph-bearing icon button — translucency there made the icon read weaker/less legible against varying photo backgrounds. A near-opaque circle gives the icon a clean, guaranteed-contrast base regardless of what's under it.

**How to apply:** Don't re-apply glassmorphism to `.wishlist-btn` (or similar single-icon overlay buttons on product photos) without asking first, even if it seems consistent with a nearby glass element like the dots pill. Visual consistency between two overlay elements isn't automatically what reads best — icon-bearing buttons and decorative pills behave differently.
