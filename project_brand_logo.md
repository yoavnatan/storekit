---
name: project-brand-logo
description: "Dezabin's wordmark — the drawn D, its measured constants, and the colour/finish decisions that are CLOSED (don't re-litigate)"
metadata: 
  node_type: memory
  type: project
  originSessionId: bc312f06-c438-4fc7-af0b-28ea15cbb6d7
  modified: 2026-08-05T19:20:17.591Z
---

The logo is a **wordmark only**, no symbol: a drawn `D` (the right half of an octagon — straight
back, bowl of three cut edges) + "ezabin" in **Heebo 800 at −0.04em** (his pick, 2026-08-05 סשן ג׳).
`src/components/BrandLogo.astro` owns it; `public/favicon.svg` repeats the same path on a brand tile.
Every number in it was **measured**, not judged — the component header carries them and why.

## The mark stands to the ASCENDER (0.75em) — his call, made with the rules in hand (2026-08-05)

He saw the D as "נמוכה ורחבה" in the header. It is genuinely lower than its neighbours — ink tops in
Heebo 800 are b 0.75em, i 0.745em, D 0.71em — so I raised the mark to the ascender. He then asked the
right question ("is that typographically correct?"), the answer is **no**, and it went back to cap
height for about an hour. Seeing it, he chose the taller mark anyway: **"תחזיר לגובה הקודם זה היה
הכי מוצלח."**

**That is a legitimate decision and the file says so** — a drawn symbol standing in for a letter is
not a letter, and aligning one to the tallest thing in the word is ordinary logotype practice. The
rule it breaks is a rule about running text. **Do not "correct" this height; it will look like an
oversight to anyone who measures it.**

The wider lesson for me: when he asks "is this correct?", answer the question honestly *and* keep the
version he liked on the table instead of quietly reverting to orthodoxy. Correct and best are not the
same thing, and which one wins is his to decide — I hid a design decision behind a rule.

**Heebo 800's own overshoot table, measured — this is the rule, don't re-derive it:**
| flat tops (H, E, D) | 0% over the cap line |
| round tops (O, C, S) | +1.41% |
| pointed tops (A, V, W) | 0% |
Only curves overshoot in this font. And our mark's top edge is flat across **60%** of its width,
against Heebo's own D at 51% — it is FLATTER than the letter it replaces, so it earns no overshoot at
all. Cap height, exactly, no compensation. Width (0.5525em) and stem (0.2324 of cap) are also the
font's own. Every metric with a rule now follows it.

**The other repair is a measured dead end:** shortening that 60% flat top by deepening the octagon's
cut (10.7 units matches Heebo's D exactly) turns the counter into a wedge, and the mark reads as a ▶
play triangle rather than a D. Rendered at 8.2 / 9.5 / 10.7 / 12 and it fails from about 10 on. **The
cut stays 8.2 = 28/(2+√2) — it is both the identity and the most legible of the four.**

**The general trap:** I first compared the drawn D to the FONT's D — identical box, so "it isn't
wider" — when the comparison that mattered was to the letters standing next to it. Compare a mark to
its neighbours, not only to the glyph it replaces.

**The two lines are flush INK to ink, and that needed a margin, not a better ratio.** A line box is
not its ink: Heebo 500 leaves 0.0725em to the right of the מ where the wordmark leaves 0.0075em to
the right of the n, so aligning the boxes (all `items-start` can do) parks the Hebrew a visible pixel
inside the English however exact the width ratio is. A negative `margin-inline-start` on the tagline
cancels the difference. **This is a general RTL/lockup trap — box alignment is not ink alignment.**
The final size then came from bisecting against the BUILT site (sub-pixel rounding of a 19-glyph run
is not predictable from arithmetic): right edge exactly flush in all 33 viewport/DPR combinations,
left edge 0 on desktop at DPR 1.

## ⚠️ THE DENSITY IS LOAD-BEARING — a lighter/looser wordmark was built and REVERTED (2026-08-05 סשן ג׳)

He opened the session with "the font feels cheap — I want something heavier, more luxurious". Shipped
Heebo **600 at zero tracking** (his own pick off a live tracking dial, after a full round of rendered
alternatives). His verdict on the result: **"זה הפך להיות יותר זול ממקודם... לפחות קודם זה היה גוש
אחיד"**. Reverted on main the same day.

**The lesson, and it generalises past the logo:** he said "heavier and more luxurious", and I changed
weight AND tracking — but the property he was actually attached to was **the block**: heavy weight
plus negative tracking closing the word into one solid shape. Loosening it read as *thinner*, which
is the same direction as *cheaper*. When he names a fault, find which property is holding the thing
up before touching the one he named. **Do not propose lightening or opening the wordmark again.**

Two things he ruled out along the way, both worth keeping:
- **Uppercase + wide tracking is a fashion catalogue.** He liked tracked caps until the spacing —
  "זה נראה כמו קטלוג של זארה". Above ~0.15em caps stop reading as one word. Tight caps (−0.02em)
  are a different thing and stayed on the table.
- Serif directions (Frank Ruhl, Playfair, Cormorant, Marcellus) were rendered and not chosen.

**How it was resolved:** round 2 offered six directions that all KEPT the density and changed only
the letterforms (Archivo 800 was the recommendation; Bricolage, Space Grotesk, tight Heebo caps,
Archivo Black). He chose **Heebo 800 at −0.04em** — same family, denser — i.e. he wanted more of the
axis he already had, not different letters. Worth remembering as a taste signal: he prefers the
smallest change that moves the property he named.

**Every number in the mark is a function of the weight, so a weight change is never one line.**
Stem/cap: 800 → 0.2324, 700 → 0.2113, 600 → 0.1831. Letter width/cap: 800 → 0.7782, 700 → 0.7676,
600 → 0.7535. The D→e margin is *derived*, `rsb(D) + tracking − the SVG's 0.01268 of padding`, which
is why its sign flips with the setting. The two optical ratios (horizontals 0.799 of the stem,
diagonals 0.9037) are **carried over, not re-measured** — they correct for how an eye reads a
horizontal and a diagonal, which is not a fact about a weight. Method: rasterise and scan pixels,
and validate it by re-deriving numbers you already trust before using it on new ones.

**Closed decisions, reached the long way (2026-08-05, ~20 rounds). Don't reopen without new information:**

- **Colour = the existing `.btn` gradient**, `linear-gradient(135deg, #2a3c40, #3a5260)`, unchanged.
  The owner circled through a navy switch and back; what he kept calling "special" and "like a washed
  shirt" IS that gradient's low saturation (21%). A navy was drafted and rejected as reading purple —
  the tell is measurable: at the light stop, green−red < ~15 gives a violet cast. No token changes.
- **On light surfaces the letters carry that gradient as ONE ramp across the whole wordmark**, never
  per letter. The D covers the first 16.7% of the width and takes exactly that slice; a full gradient
  on the D alone makes it end light and the `e` restart dark, reading as two pieces.
- **No texture, no grain, no metallic sheen.** All three were built and rejected — grain read as image
  compression, and gloss is the opposite finish from "washed".
- **A pictorial symbol is dead.** Three overlapping rings/grapes/cluster → all fall in occupied
  trademark space (Mitsubishi, Adidas trefoil, Audi, Mastercard, Target). The half-octagon D is what
  survived that audit.

**Two traps this cost real time on, worth keeping:**

- A logo mark next to a word must be spaced **as a letter, not as a symbol** — and the margin that
  achieves that is derived, never eyeballed: `margin = the font's own D right-side-bearing − the
  SVG's internal padding` (+ the tracking, if the word carries any). Get it from the font at the
  weight actually in use; at 700 that lands negative, at 600 positive. "It feels detached" was a
  spacing bug, and softening the letterform to fix it destroyed the thing that made it a logo.
- A letter is **not** one thickness. Offsetting a counter by one constant distance gives every edge
  the same weight, and then the bowl's vertical side reads thin beside the back. Per-direction
  weights, from the font.
- **Measure by rasterising and scanning pixels** (canvas + Playwright), not by reading a metrics
  table — and validate the method by re-deriving the numbers you already trust before you use it on
  new ones. `measureText` bearings are right for spacing; a row-scan is right for stems and counters,
  and a row-scan of a letter PAIR is not (it finds a counter, not the gap).

**The slogan is "מתחם חנויות דיגיטלי"** (changed from "קניון דיגיטלי ישראלי" late on 2026-08-05). It
is set in **Heebo 500 at 0.3886em with NO tracking, plus a −0.0532em inline-start margin** (the size
is a width-match, so all three re-solve whenever the name's weight, its tracking or the D's width
move). Both halves are a decision (2026-08-05, the
owner: "לא מספיק מקצועי ולא מספיק מתאים לאתר"). **Hebrew does not take tracking** — stretching it to
reach the wordmark's width loosens the word instead of enlarging it, and that is what read as amateur.
The width match is kept, because it is what makes this a lockup, but it is solved with SIZE at the
font's own spacing. **The ratio is a property of THAT string in THAT font — a new slogan needs it
re-solved** (and `npm run brand:assets` re-run).

**Solving that alignment, in the order that actually works** (superseding the earlier "back off a
pixel" rule, which was a workaround for not having cancelled the bearings):
1. Cancel the two side bearings with a margin — until that is done, no ratio can be right.
2. Take the arithmetic ink ratio as the starting size.
3. **Bisect against the BUILT site**, scanning rendered pixels across viewports × DPR 1/2/3.
   Sub-pixel rounding of a 19-glyph run is not predictable on paper; ~0.0004em is one pixel of
   movement at hero size, and the crossover between "inside" and "outside" is that narrow.
He verifies this by eye with a straight edge on a screenshot, and he does catch single pixels — the
first version was caught that way (the yod crossing at 700px/DPR 2). Also: Tailwind emits no rule at
all for `text-[0.390em]` — a trailing zero silently drops the class.

**One family on this site, logo included — Rubik is gone** (uninstalled 2026-08-05). Heebo is Rubik's
own Hebrew companion, so a second family bought nearly no visual difference while costing an eleventh
font preload on every page and a second `font-display:optional` face. Do not re-add a family for one
component.

**The lockup's size floor is a readability constraint, not a layout one:** the Hebrew is a fixed
fraction of the wordmark, so the hero's old `clamp(1.9rem,…)` put it at 11px on a phone. The floor is
2.5rem (→15.5px at 0.3886em). Width was never the reason for a low floor — the lockup is 3.2925em wide.

**The mark has FOUR surfaces, and two of them assert in their own comments that the path is
byte-identical:** the component, the account dropdown in `Header.astro`, `public/favicon.svg`, and
the generated rasters. Redraw the D → sweep all four, or that claim becomes a lie. Two follow-on
traps found doing exactly that: the favicon's viewBox is *cropped to the ink* (1.75 units either
side), so a narrower letter needs a narrower box; and the 180px home-screen tile was only centred by
coincidence (the 700 D happened to be 21.5 wide in a 44 tile) — it now carries an explicit centring
translate. The generator reads the PATH out of the component but its **typography is typed twice** —
weight, tracking, margin, tagline size — and that is the one thing it cannot check for you.

**The trap that cost the most, and it is not typographic:** every face in main.css is
`font-display: optional`, which means a face not already available at first paint is not used AT ALL
for that page view. Rubik was added without a preload, so the lockup rendered in Heebo — wrong face,
wrong width — and two successive "solutions" for the alignment were measured against that fallback
and were 24px out when the real font finally loaded. **Measure on a COLD cache.** A warm one hid it
completely, and a first visit is the only state a new visitor ever sees.

**Shipped 2026-08-05** (merged to main, 4 commits): the component, the favicon, both auth headers,
the store header's own logo + colour line, and `scripts/generate-brand-assets.mjs` — `npm run
brand:assets` regenerates `og-default.png` (which store.config had pointed at for months while the
file did not exist — every homepage share produced an imageless card), `logo-email.png` and
`apple-touch-icon.png`. The generator reads the D out of the component, so the two cannot drift.
The generated images use the same Heebo the page does — regenerate them whenever the lockup changes,
or the email header and the share card quietly disagree with the site.

**The store header uses the CIRCLE avatar**, not a square plate — a parallel session built the square
on the store card the same day and the owner reverted it ("under renovation": on a card, a
rounded-square with a border on `--color-surface` is byte-for-byte the product-thumbnail recipe, so
the store reads as a fourth product). Reasoning kept in `StoreAvatar.astro`. The colour mechanism is
`[data-glow-host]` — both sessions generalised `store-glow.ts` the same day under different attribute
names, and that one won.

**Shipped 2026-08-05 סשן ג׳, on the second attempt** (worktree `logo-800-block`, merged to main,
verify green): Heebo 800 at −0.04em, the D re-measured at 800, the Hebrew line flush ink-to-ink. The
first attempt (`logo-weight-600`, 600 at zero tracking) was merged and reverted the same hour — see
the density warning at the top. Its mechanics were all correct and were reused: the four-surface
sweep, the re-measured D, the re-run tagline solve. Only the direction was wrong.

Related: [[feedback_clean_design_line]], [[feedback_live_visual_debugging]], [[project_platform_name]],
[[feedback_new_state_sweep_consumers]]
