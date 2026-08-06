---
name: project-reset-css-layer-bug
description: "reset.css's unlayered `button { border:none; background:none }` was silently beating every Tailwind border/bg utility on buttons project-wide — fixed 2026-07-15 by importing reset.css with layer(base)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 57cbef8d-eb7b-45d7-b8ed-0c57b64293c5
---

Found 2026-07-15 during the dashboard.css Tailwind migration ([[feedback_css_migration_pace]]): `src/styles/main.css` imported `src/styles/base/reset.css` unlayered (deliberately, so legacy component CSS like buttons.css/dashboard.css "takes precedence" over stray Tailwind utility bleed). But `reset.css` also contains a generic `button { border: none; background: none; }` reset — and per the CSS Cascade Layers spec, ANY unlayered rule beats ANY `@layer`'d rule regardless of specificity or layer order. So that one rule silently nullified every Tailwind `border-*`/`bg-*` utility applied to a `<button>` element anywhere on the site.

**Confirmed pre-existing damage**: the bug is a global CSS mechanism (unlayered beats `@layer`'d, universally, on every `<button>`), so it silently affected every button-based border/bg Tailwind utility added in every earlier round of this migration too (PQV's `#pqv-close`, nav arrows, qty stepper; checkout's buttons; category-tree's buttons) — none of it was ever actually visible as broken in prior "verified" passes because the fallback (transparent) often looked close enough not to register as wrong. Caught this round because `category-picker__trigger`'s border color needed to visibly swap on `aria-expanded`, which made the missing border obvious in a computed-style check.

**Fix**: changed `@import './base/reset.css';` to `@import './base/reset.css' layer(base);` in `src/styles/main.css` — this merges reset.css into Tailwind's own "base" layer (same semantic role as Tailwind's preflight), so component-level Tailwind utilities in later layers can override it as intended. Other legacy CSS files (buttons.css, dashboard.css, etc.) were deliberately left unlayered — only reset.css changed, since it's a base-level reset not a component library.

**How to apply**: any future round of the Tailwind migration that adds `border`/`bg-*` utilities to a raw `<button>` element should now work correctly without special-casing. If a *new* similarly-unlayered legacy rule is ever found blocking a Tailwind utility, the same `layer(base)` (or `!` important modifier for a one-off) fix pattern applies — check `main.css`'s import list first before assuming the utility syntax itself is wrong.
