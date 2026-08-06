---
name: project-prepaint-seed-drift
description: Header inline pre-paint seeds duplicate a client rule; any drift makes the badge roll old→new on every page load
metadata: 
  node_type: memory
  type: project
  originSessionId: a4c164a9-9312-4745-9abd-c17ad7a397aa
  modified: 2026-07-31T14:22:53.836Z
---

Header.astro paints the cart/wishlist badge (and the back-to-store pill) TWICE per load: an
inline `is:inline` seed that runs synchronously before first paint, then the deferred module
reading the same state through `lib/`. Two implementations of one rule, because an inline
script cannot import.

When they disagree the odometer stages the seed's number as the "previous" digit and rolls off
it — on EVERY navigation, since the disagreement is a property of stored state, not of anything
the shopper did. Shipped once: the seed counted `gone` lines that `getCount()` excludes
(2026-07-31).

**Why:** it reads as a header that never settles, and it is invisible in code review — both
sides look correct in isolation.

**How to apply:** any new pre-paint seed must (a) reproduce its `lib/` rule exactly, (b) be
covered in `tests/header-cart-badge.test.ts`, which extracts the seed from the .astro source and
runs it against the real lib, and (c) have its page-load reconcile pass `{ animate: false }` to
`updateBadge` so residual drift snaps silently instead of flickering. Anything revealed late in
the header row shifts its siblings — the row is `justify-content:space-between`. Related:
[[project-client-renderer-i18n-drift]], [[feedback-new-state-sweep-consumers]],
[[feedback-noop-interactions-invisible]].
