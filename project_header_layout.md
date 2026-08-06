---
name: project-header-layout
description: "Header is position:fixed (not sticky) — content bounces, header stays still"
metadata: 
  node_type: memory
  type: project
  originSessionId: 73ddbb50-ad97-4776-8a1f-cccf8fbfdfab
---

The site header uses `position: fixed; top: 0; left: 0; right: 0` so it stays anchored to the viewport during native browser rubber-band scroll — only the page content bounces, not the header.

`body { padding-top: 3.3rem }` compensates for the fixed header's height (≈ 2×0.65rem padding + 1.9rem user-btn + 1px border).

**Why:** User tried the full app-shell approach (100vh overflow:hidden, inner scroller) multiple times but it caused zoom issues, choppy scroll, and clipped bounce. Fixed header + document scroll is the simplest correct solution.

**How to apply:** Do not change `.site-header` to `position: sticky` — it must stay `fixed`. If header height changes, update the `body { padding-top }` value in `src/styles/components/header.css`.

**Vertical centring in this row has been "fixed" three times with the sign flipped — the only
method that lands it is a two-point solve (2026-08-05).** Never derive the nudge from a box or a
font metric: measure the ink centre on a BUILD at 8x with the transform at 0 and at some value,
and read off the crossing. The wordmark's `translateY` went 0.166em → 0.113em that way, after
0.166 had pushed the letters 1.1px PAST the icons — the same complaint as before it, with the sign
reversed, which is why it kept coming back. Also: the header's height is pinned inline with
`box-sizing:border-box` and 1px of it is the border, so a flat `padding-block` does NOT centre the
row in the white bar — it is `calc((3.4rem - 1px - 2rem) / 2)`.

**A flush-ink neighbour makes a gap look SMALLER, not larger.** The avatar is a filled circle whose
ink reaches its box edge; the cart/heart/bell are line glyphs inset inside their viewBox. A uniform
flex gap therefore reads tightest beside the avatar (measured: 10.00px vs 14.38 and 15.00 with a
-4px pull that had been added on exactly the opposite reasoning). Removing the pull evened it to
14.00/14.38/15.00.

**`.site-header--store` is a LAYOUT class, never an identity (found 2026-08-05).** Thirteen pages that
are not a store ask for that layout — homepage, /stores, /search, /checkout, 404, seller
login/register/dashboard, every admin screen. A store's 2px colour bar was selected on the class
alone, so all thirteen wore it in its no-colour fallback: 2px rgb(140,147,161) where the entire rest
of the site draws a 1px `--color-border` hairline. **Everything on this site is 1px** — if a line
looks heavier, look for a `::after` covering the border, not for a different border-width. The gate
was `[data-glow-host]`, and narrowing to it exposed the real problem underneath — the colour is
sampled from the logo ON THE CLIENT, so it can never be right at first paint. **A parallel session
removed the coloured bar entirely on 2026-08-05, at the owner's call**; the header now has ONE line
everywhere, the shared 1px hairline, and `tests/header-store-line.test.ts` exists to stop it coming
back. The general lesson: before styling on a class, ask whether the class means "looks like X" or
"is an X".
