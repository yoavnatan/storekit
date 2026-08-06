---
name: project_injected_overlay_flash
description: "A JS-injected overlay declared visible flashes on load — a forced layout resolves its style lit, then the state-class toggle transitions it out"
metadata: 
  node_type: memory
  type: project
  originSessionId: ad7a3b41-b5b3-4b57-9ec3-2dfa0579e2ba
  modified: 2026-08-01T21:56:28.405Z
---

An overlay that JS creates and JS then decides the visibility of must be declared
in its HIDDEN resting state, with the state classes turning it ON. Declaring it
visible and hiding it a line later is not free: any `scrollWidth`/`getBoundingClientRect`
read between insertion and the class toggle forces a style resolution while the
element is still lit, so the toggle becomes a real transition — a visible flash on
every load.

Hit 2026-08-02: `.dash-tab-fade` (injected by `initDashTabs()`) washed the homepage
tab labels white for 150ms on every refresh, because `syncEdges()` reads `scrollWidth`
before toggling `at-start`/`at-end`. Invisible on the dashboards (surface-over-surface),
plain on the homepage's `--color-bg` strip. `.home-tabs-arrow` already followed the
rule; guard: `tests/tab-fade-default-hidden.test.ts`.

Related: [[project_skeleton_js_visibility_gate]], [[feedback_noop_interactions_invisible]].
