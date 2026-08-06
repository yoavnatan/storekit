---
name: project-view-transitions-font-blocker
description: "view transitions are CLOSED (owner, 2026-08-05): he does not want a fade over the content between pages. The header-stability complaint that keeps sending sessions here is a real bug class, not a transitions gap — see project_header_stability"
metadata:
  node_type: memory
  type: project
  originSessionId: 12cd9e8e-b1c6-4703-9b37-2743944b4630
  modified: 2026-08-05T12:03:09.096Z
---

**Owner decision, 2026-08-05 — stop proposing this.** Asked to choose between native
`@view-transition` and Astro's `ClientRouter`, he rejected both on the same ground: *"אני לא רוצה
כזה אפקט של פייד על כל התוכן בין מעבר למעבר, שזה מה שאז עשית וזה היה נורא לא יפה."* The
2026-07-16 attempt is remembered as ugly, not as a timing failure. What he actually wants, and has
now said twice, is narrow: the header never blinks out between a store page and the homepage, and
its content does not change shape. That is [[project_header_stability]] — a set of ordinary bugs
with ordinary fixes, and it was fully solved without any transition mechanism.

**Do not re-propose either mechanism.** Not the native CSS one, not `ClientRouter`, not a scoped
variant. If a `CURRENT_TASK.md` instruction names one (a previous session wrote exactly such a
prompt and he explicitly warned "אל תניח שהוא צודק"), treat the stated *goal* as the task and this
memory as the answer on mechanism.

**The two technical facts, kept only so they are not re-derived:**

- The old blocker is genuinely gone — Heebo is self-hosted via `@fontsource/heebo` with all
  weight×script combos preloaded in `BaseLayout.astro`, and there is no `fonts.googleapis.com`
  reference anywhere in the tree. So "the font blocker is fixed, we can retry" is true and
  irrelevant; the objection is aesthetic.
- `ClientRouter` would be far more expensive here than it looks, and the estimate in that old
  prompt ("23 modules with module-level state") understates it by an order of magnitude. Astro's
  `swap-functions.js#deselectScripts` keys every script by `src` (or by `textContent` when inline)
  and marks any that already ran as executed, so **every** script runs exactly once per visit —
  bundled modules and `.astro` `<script>` blocks alike. That is ~23,500 lines of client code here:
  15,073 in `src/scripts/` plus 8,416 inside `.astro` files (1,510 on the store page, 1,106 on the
  buyer dashboard, 915 on checkout, 903 in the header). Store A → store B would leave store B with
  no page script at all. Anything reviving this needs `astro:page-load` wiring for all of it.
