# The lockup that shipped until 2026-08-21

The Chakra Petch wordmark, kept whole rather than only in git history — the owner
asked for the previous logo to be somewhere he could look (2026-08-21), and a
branch is not that place.

## What is here

| file | what it was |
| --- | --- |
| `dezabin-wordmark*.svg` | the drawn D + "ezabin", in the ramp, in brand colour, and in white |
| `dezabin-mark*.svg` | the octagon D alone |
| `dezabin-lockup*.svg` | wordmark + the Hebrew slogan, flush at both ends |
| `favicon.svg` | the tab icon |
| `logo-email.png` | the mail header raster |
| `apple-touch-icon.png` | the home-screen tile |
| `brand-lockup.ts.bak` | the generated module every surface imported |
| `generate-wordmark.mjs.bak` | the generator that wrote all of the above |

## What it was

A drawn `D` — the right half of a regular octagon, straight back and three 45°
cuts — followed by "ezabin" in **Chakra Petch 700**, tracked −0.04em, thickened
0.014em with a centred stroke, and with every ink gap levelled to their mean. The
Hebrew slogan sat under it flush on both ends, matched by size.

## Why it was replaced

The owner's read, over 2026-08-21: *"too square relative to the site, as if it
isn't connected to it"*, then *"something artificial and stuck, too amateurish"*.
The octagon was the whole of what read as square, and every softer replacement
drawn that day was rejected in turn — a bowl wrapping past the arm, a chamfered
wrap, a tapered tail, a short flat foot — either as unclear or as childish. The
brief that came out of it was *"a clear, ordinary typeface, thick enough to see,
stable, classic"*, which a drawn letter cannot be.

## Rebuilding it

`generate-wordmark.mjs.bak` still runs: it reads `ChakraPetch-Bold.ttf` and
`Heebo-Medium.ttf`, which are kept in `assets/brand-fonts/` for exactly this
reason and are not read by anything live. Copy it over `scripts/generate-wordmark.mjs`,
run `npm run brand:wordmark` and then `npm run brand:assets`, and revert
`src/components/BrandLogo.astro` — the current one centres the second line and
takes a per-language tracking, neither of which the old module exports.
