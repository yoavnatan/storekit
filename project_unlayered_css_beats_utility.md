---
name: project-unlayered-css-beats-utility
description: A Tailwind state utility is silently dead when a legacy class on the same element sets that property from an unlayered sheet
metadata: 
  node_type: memory
  type: project
  originSessionId: f1920bee-d965-48b7-9492-f748aa8f6ed1
  modified: 2026-08-05T20:39:32.349Z
---

Every stylesheet `main.css` imports **without** `layer(...)` outranks `@layer
utilities`, however specific the utility is. So a `hover:` / `focus:` /
`aria-expanded:` utility for a property a legacy class on the SAME element
already sets **never applies, and nothing warns** — the element just never
changes state, which reads as broken JS.

Three times: reset.css's bare `button { border:none; background:none }` killing
every border/bg utility site-wide (2026-07-15, fixed by importing reset.css into
`layer(base)`); the avatar menu's saved-stores row, where
`.user-dropdown__item { background:none }` ate `aria-expanded:[background:…]`
and the row only looked lit because the pointer rested on it; and the category
picker's trigger, where `.input`'s `border` shorthand had eaten both
`hover:border-*` and `aria-expanded:border-*` since the day it was written.

**How to apply:** the fix is never Tailwind's `!` — that is a second rule about
the same property in the file that does not own the element. Put the state rule
in the stylesheet that already styles it, keyed on the state
(`.foo[aria-expanded="true"] { … }`). Guarded tree-wide by
`tests/unlayered-css-beats-utility.test.ts`, which reads main.css for the
unlayered imports and fails on any such pairing. Related:
[[project-reset-css-layer-bug]], [[project-css-class-name-collision]],
[[feedback-tailwind-image]].
