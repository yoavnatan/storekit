/**
 * Two ways the seller's navigation column can strand him, both of which it did.
 *
 * **1. A width with no control.** The rail collapses to 3.75rem of unlabelled icons below 1180px
 * because the width decides there, and below 768px it becomes a drawer with a trigger in the site
 * header (900px until 2026-08-25 — dashboard.css argues the value). The chevron that opens it was
 * hidden below 1180 — so between the drawer's edge and 1180 there was no
 * control at either end: icons with no names, no way back to the labels, and no footer at all,
 * since the foot is `display:none` while collapsed (owner, 2026-08-24: *"יש רוחב מסויים שפשוט אין
 * דרך לפתוח את תפריט הצד ויש שם רק אייקונים) ואז בעצם - אין פוטר"*).
 *
 * The invariant that band violated is the one this file pins: **the width at which the chevron
 * disappears must be the width at which the header's trigger appears.** One number, written twice
 * in `dashboard.css`, and nothing in CSS complains when the two drift — the symptom is a range of
 * viewport widths, which is exactly what nobody resizes through by hand.
 *
 * **2. A footer with no help.** `/help` is the surface built so a seller does not have to write in
 * (`lib/help.ts`), and the dashboard's own footer — the page a seller actually works on — was the
 * one place that never linked to it (owner, same day: *"לא הבנתי למה העזרה לא מופיעה גם כשהמוכר
 * כבר מחובר"*). It reached the site footer and stopped there.
 *
 * Neither check needs a browser, and that is the point: both defects are a viewport band or a
 * missing link, which a render test at one width and one page cannot see.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

const CSS = read('src/styles/pages/dashboard.css');
/** Prose in this file quotes selectors and old breakpoints; only live rules are the subject. */
const LIVE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the media query that opens at `index`, brace-matched so a rule in a LATER block is
 *  never credited to this one. */
function blockFrom(index: number, openLen: number): string {
  let depth = 1;
  let i = index + openLen;
  for (; i < LIVE.length && depth > 0; i++) {
    if (LIVE[i] === '{') depth++;
    else if (LIVE[i] === '}') depth--;
  }
  return LIVE.slice(index, i);
}

/** The `max-width` of the media query whose body contains `needle`. */
function bandMax(needle: string): string | null {
  const re = /@media[^{]*\(max-width:\s*([\d.]+)px\)[^{]*\{/g;
  for (let m = re.exec(LIVE); m; m = re.exec(LIVE)) {
    if (blockFrom(m.index, m[0].length).includes(needle)) return m[1];
  }
  return null;
}

/**
 * The over-content band, **DERIVED and never typed**. Its lower edge is by definition the width at
 * which the header's trigger takes over — the very thing the first test asserts — so a literal here
 * is a second copy of that number, and this file exists because a number written twice drifts.
 * It drifted immediately: the boundary moved 900 → 768 on 2026-08-25 (the owner's "hamburger on
 * mobile only"), the CSS and both scripts moved together, and this constant did not — two red
 * assertions about a band that no longer existed, on a change that was correct.
 */
const DRAWER_MAX = bandMax('.dash-nav-trigger { display: inline-flex; }');
const OVER_BAND = `@media (min-width: ${Math.round(Number(DRAWER_MAX) + 0.02)}px) and (max-width: 1179.98px)`;

describe('the collapsed rail can always be opened', () => {
  it('hides the chevron at exactly the width where the header trigger takes over', () => {
    const chevronGone = bandMax('.dash-rail-toggle { display: none; }');
    const triggerAppears = bandMax('.dash-nav-trigger { display: inline-flex; }');
    expect(chevronGone).not.toBeNull();
    expect(triggerAppears).not.toBeNull();
    // Not "chevron ≤ trigger": equal, because a gap either way is a defect. Higher leaves a band
    // with no control at all (the bug); lower puts two controls on screen for one list.
    expect(chevronGone).toBe(triggerAppears);
  });

  it('opens over the content without giving the panel a different width', () => {
    // The band's whole reason: at 1000px an expanded column would leave the products table under
    // 750px, which is the measurement the drawer breakpoint itself came from. So the open state
    // floats the rail and pins the COLUMN at the collapsed width.
    const at = LIVE.indexOf(OVER_BAND);
    expect(at).toBeGreaterThan(-1);
    const body = blockFrom(at, OVER_BAND.length + 2);
    expect(body).toMatch(/\[data-nav-open\][^{]*\{[^}]*position:\s*fixed/);
    expect(body).toMatch(/--dash-rail-w:\s*3\.75rem/);
  });

  it('gives the floating rail a height rather than stretching it between top and bottom', () => {
    // Measured: `top` + `bottom: 0` + `height: auto` left the box 737px tall in a 900px window —
    // an out-of-flow grid item sized by its own content. The symptom is a panel stopping short of
    // the bottom edge, which reads as a rendering fault rather than as a choice.
    const at = LIVE.indexOf(OVER_BAND);
    const rule = /\[data-nav-open\]\s*>\s*\.dash-rail\s*\{([^}]*)\}/.exec(blockFrom(at, OVER_BAND.length + 2));
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/height:\s*calc\(100vh/);
    expect(rule![1]).not.toMatch(/\bbottom:/);
  });
});

describe('the help centre is reachable from where a seller works', () => {
  it('is linked from the dashboard rail foot', () => {
    expect(read('src/components/dashboard/DashRailFoot.astro')).toContain('href="/help"');
  });

  it('is linked from the site footer', () => {
    expect(read('src/components/Footer.astro')).toContain('href="/help"');
  });
});
