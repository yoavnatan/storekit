import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The "injected overlay must default to its hidden state" guard.
 *
 * The bug it exists for: the homepage tabs flickered white on every refresh
 * (owner, 2026-08-02). `initDashTabs()` creates the two `.dash-tab-fade` spans
 * at runtime and then calls `syncEdges()`, which reads `strip.scrollWidth` —
 * a forced layout — BEFORE it toggles `at-start`/`at-end`. So the fade's first
 * computed style was resolved while it was still fully lit, and the class toggle
 * one line later turned that into a real 150ms `opacity: 1 → 0` transition: the
 * strip's own background washing over the outermost tab labels on every load.
 * On the two dashboards the fade is `--color-surface` over `--color-surface`, so
 * it hid there; the homepage strip is `--color-bg` and it was plainly visible.
 *
 * THE RULE: an overlay that JS injects and JS then decides the visibility of
 * must be declared in its RESTING (hidden) state, with the state classes turning
 * it ON. Declaring it visible and hiding it a moment later cannot be free — the
 * gap between insertion and the class toggle is exactly one forced layout wide,
 * and any transition on the property turns that gap into a visible flash. It is
 * also the correct no-JS state: a page whose module never ran shows nothing
 * rather than a permanently-lit overlay. `.home-tabs-arrow` (home.css) already
 * follows this and says so in its own comment; the fades did not.
 */

const DASHBOARD_CSS = fileURLToPath(new URL('../src/styles/pages/dashboard.css', import.meta.url));

describe('tab edge fades', () => {
  const css = readFileSync(DASHBOARD_CSS, 'utf8');
  const base = css.match(/\.dash-tab-fade\s*\{([^}]*)\}/)?.[1];

  it('declares the base overlay hidden', () => {
    expect(base).toBeDefined();
    expect(base).toMatch(/opacity:\s*0\s*;/);
  });

  it('lights each fade off the state classes rather than hiding it off them', () => {
    // The lit rule must be gated on `is-scrollable` + `:not(.at-…)`. A rule that
    // instead sets `opacity: 0` off `.at-start`/`.at-end` means the base state is
    // visible again — the exact shape that flashed.
    expect(css).toContain('.dash-tabs.is-scrollable:not(.at-start) .dash-tab-fade--start');
    expect(css).toContain('.dash-tabs.is-scrollable:not(.at-end) .dash-tab-fade--end');
    expect(css).not.toMatch(/\.dash-tabs\.at-(start|end)\s+\.dash-tab-fade/);
  });
});
