---
name: feedback_clean_design_line
description: "Stop inventing per-component decoration — take the treatment from the site's existing language; and call out weak ROI instead of grinding through design rounds"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5237b9bb-5efd-4223-b379-8a808f325a1c
  modified: 2026-07-30T10:04:29.254Z
---

User's own conclusion after ~10 rounds on ONE sale banner (2026-07-30): "המסקנה היא תמיד להישאר עם
קו נקי של עיצוב בלי להשתגע. לזכור את השפה הכללית של האתר."

Nine treatments were built and rejected: saturated green fill, 1px outline on a 3% tint, that outline
with a warm second hue in four arrangements, a light travelling the frame, a near-black green panel, a
soft green tint with its own gradient, a gift ribbon (diagonal then vertical), an oversized cropped
gift glyph, a green accent bar (top edge, then ringing the perimeter). Also no-box (too naked) and
shrink-to-fit (an orphan chip). What shipped: `.card`'s existing recipe plus the green figure.

**Why:** every rejected version was invented FOR that component. A bespoke treatment reads as imposed
even when each individual value is defensible — that is the actual failure mode, not bad taste in
colour. The four tests are now a hard rule in AI_INSTRUCTIONS.md → "Design line — decide by it, not by
taste" (is it already in the system / would it date / does it suit every category / is the colour
already spoken for). Read it BEFORE building, not after.

**How to apply:**
- Reach for a token, an existing component recipe, or an existing gesture first. Grep for one.
- Colour with an assigned job stays on that job (`--color-sale` is the price signal, not a frame).
- When a look gets rejected 2–3 times, stop iterating and say the ROI is weak — propose the
  known-good baseline instead of trying variant N+1. I should have said it around round four.
- Screenshots are not optional: tsc, lint and all 894 tests passed while a broken JSX comment was
  printing prose onto the live store page. See [[feedback_live_visual_debugging]].

Related: [[feedback_design_philosophy]], [[feedback_roi_check_before_grinding]],
[[feedback_light_theme_glint]], [[project_tactile_depth_expansion]].
