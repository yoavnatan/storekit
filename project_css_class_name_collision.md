---
name: project_css_class_name_collision
description: "before adding a new CSS utility class, grep the name — a pre-existing definition with a [dir]/ancestor prefix outranks a bare class and wins silently"
metadata: 
  node_type: memory
  type: project
  originSessionId: 91fdc73e-5366-4d16-8a67-1da18c993a6a
  modified: 2026-07-30T13:05:08.946Z
---

**Grep a CSS class name across `src/styles/` before defining it.** A pre-existing
definition qualified by an ancestor or attribute (`[dir="rtl"] .edge-fade`, 0,2,0)
outranks a bare new one (`.edge-fade`, 0,1,0) and wins regardless of import order —
so the new rule appears to do nothing and the old one paints instead.

**Why:** hit 2026-07-30 adding an `.edge-fade` mask utility for the /stores chip
row. `components/store-card.css` already defined `.edge-fade` (its own
`--fade-start`/`--fade-end` plus a `[dir="ltr"]`/`[dir="rtl"]` mask pair) and it was
already dead CSS — the caller it named no longer used the class. The stale rule
outranked the new one and masked the row with properties nobody set, i.e. a
zero-width gradient: a hard clip that looks exactly like no fade at all. No error,
nothing in the console.

**The debugging lesson is the expensive part.** I read `--fade-left: 24px` on the
element and a computed `mask-image` pinned at `0px`, and concluded from that pair
alone that `var()` in a gradient color-stop position doesn't re-substitute — then
wrote that fabricated browser limitation into three files' comments. A 20-line
`page.setContent()` experiment disproved it immediately (both the same-rule and
separate-rule forms substitute fine). **When computed CSS disagrees with the rule
you just wrote, suspect a second rule winning before suspecting the engine** — check
which declaration actually applies, don't infer a platform bug from one symptom.
Same family as [[project_reset_css_layer_bug]] and
[[project_tailwind_hidden_vs_flex]]: in this codebase the cause is almost always
another stylesheet, not the browser. Related: [[feedback_dont_imply_unverified_diligence]].

**Also:** `.home-shelf` has `padding-inline: 8px` and rests at `scrollLeft ±8`, so
`scrollWidth > clientWidth` is NOT an overflow test there — it over-reports by 16px.
index.astro's `EDGE_SLOP` (12) is what absorbs it. I briefly reported the homepage
fade as "dead" off that false positive; it was fine.
