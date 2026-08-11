// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { buildLineChartSvg, buildMultiLineChartSvg } from '../src/lib/chart-svg.js';
import { showTooltip, showSeriesTooltips, hideTooltip } from '../src/scripts/tooltip.js';

/**
 * Two rules the owner asked for on the visits chart (2026-08-11), and both are split across two
 * files — the SVG has to offer the right hit surfaces and carry the right data, the tooltip module
 * has to place the right number of boxes — so they are driven together here.
 *
 *  1. TWO tooltips, one per series, each beside its own point and in its own colour. A single box
 *     explaining both read as one sentence in one colour, and the colour was one of the two.
 *  2. They appear on the LINE or the DOTS, never anywhere in the point's column. Pointing at empty
 *     space near the top of the box used to explain a value drawn near the bottom of it.
 */
const SERIES = [
  { points: [{ label: '01/08', value: 12 }, { label: '02/08', value: 30 }], color: 'var(--color-accent)', fill: true, label: 'מבקרים ייחודיים' },
  { points: [{ label: '01/08', value: 40 }, { label: '02/08', value: 91 }], color: 'var(--color-muted)', dashed: true, label: 'ביקורים' },
];

const render = (svg: string): void => { document.body.innerHTML = `<div id="chart">${svg}</div>`; };

describe('a line chart is hoverable on its marks, not on its box', () => {
  it('the column rect no longer answers a cursor — it only carries the text', () => {
    render(buildMultiLineChartSvg(SERIES, { animate: false }));
    const rect = document.querySelector('.chart-point .chart-bar')!;
    expect(rect.getAttribute('pointer-events'), 'the full-height column is inert').toBe('none');
    // It still holds the label/value an older client and the single-series path read back.
    expect(rect.getAttribute('data-label')).toBe('01/08');
    expect(rect.getAttribute('data-value')).toBe('מבקרים ייחודיים 12 · ביקורים 40');
  });

  it('every point gets a generous hit circle, one per series', () => {
    render(buildMultiLineChartSvg(SERIES, { animate: false }));
    const hits = document.querySelector('.chart-point')!.querySelectorAll('.chart-hit');
    expect(hits.length, 'one per series, so either line’s point can be pointed at').toBe(2);
    // 9 against the drawn 2.4: a 2.4px dot is not a pointing target.
    expect(hits[0]!.getAttribute('r')).toBe('9');
  });

  it('the line itself is hoverable between points', () => {
    render(buildMultiLineChartSvg(SERIES, { animate: false }));
    const hitLines = document.querySelectorAll('.chart-hit-line');
    expect(hitLines.length, 'one per series — the dashed envelope too').toBe(2);
    const hit = hitLines[0]!;
    expect(hit.getAttribute('stroke')).toBe('transparent');
    expect(Number(hit.getAttribute('stroke-width'))).toBeGreaterThanOrEqual(12);
    // Stroke only, and no fill: the area UNDER the curve must not become a hit surface, which
    // would quietly re-create the column this replaces.
    expect(hit.getAttribute('pointer-events')).toBe('stroke');
    expect(hit.getAttribute('fill')).toBe('none');
  });

  it('single-series line charts get the same treatment', () => {
    // The orders chart and the per-product views chart are lines too — leaving them column-wide
    // would make the same page behave two ways.
    render(buildLineChartSvg(SERIES[0]!.points, { animate: false }));
    expect(document.querySelector('.chart-point .chart-bar')!.getAttribute('pointer-events')).toBe('none');
    expect(document.querySelectorAll('.chart-hit-line').length).toBe(1);
    expect(document.querySelector('.chart-point')!.querySelectorAll('.chart-hit').length).toBe(1);
  });
});

describe('each series names itself on its own dot', () => {
  it('label, value, colour and dash state ride on the dot', () => {
    render(buildMultiLineChartSvg(SERIES, { animate: false }));
    const dots = [...document.querySelector('.chart-point')!.querySelectorAll('.line-dot[data-label]')];
    expect(dots.length).toBe(2);
    expect(dots.map((d) => d.getAttribute('data-label'))).toEqual(['מבקרים ייחודיים', 'ביקורים']);
    expect(dots.map((d) => d.getAttribute('data-value'))).toEqual(['12', '40']);
    // The colour comes off the dot, which is where it already lives — so a tooltip anchored to it
    // cannot end up describing one line in the other's colour.
    expect(dots.map((d) => d.getAttribute('fill'))).toEqual(['var(--color-accent)', 'var(--color-muted)']);
    expect(dots[1]!.getAttribute('data-dashed')).toBe('1');
    expect(dots[0]!.getAttribute('data-dashed')).toBeNull();
  });

  it('a single-series chart identifies no dot, so its tooltip stays the plain one', () => {
    render(buildMultiLineChartSvg([SERIES[0]!], { animate: false }));
    const dots = document.querySelector('.chart-point')!.querySelectorAll('.line-dot[data-label]');
    expect(dots.length).toBe(1);
  });
});

describe('showSeriesTooltips', () => {
  beforeEach(() => { hideTooltip(); document.body.innerHTML = ''; });

  const tips = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('.dash-tooltip')].filter((el) => !el.hidden);

  /** Two anchors at known heights — `a` above `b` on screen. */
  function anchors(): { a: HTMLElement; b: HTMLElement } {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    a.getBoundingClientRect = () => ({ top: 40, bottom: 44, left: 100, width: 4, height: 4 }) as DOMRect;
    b.getBoundingClientRect = () => ({ top: 120, bottom: 124, left: 100, width: 4, height: 4 }) as DOMRect;
    return { a, b };
  }

  it('shows one tooltip per series, each in its own colour', () => {
    const { a, b } = anchors();
    showSeriesTooltips([
      { anchor: a, text: 'מבקרים ייחודיים 12', color: 'var(--color-accent)' },
      { anchor: b, text: 'ביקורים 40' },   // no colour → the default dark box
    ]);
    const shown = tips();
    expect(shown.length, 'two boxes, not one explaining both').toBe(2);
    const texts = shown.map((el) => el.textContent);
    expect(texts).toContain('מבקרים ייחודיים 12');
    expect(texts).toContain('ביקורים 40');
    const blue = shown.find((el) => el.textContent === 'מבקרים ייחודיים 12')!;
    const black = shown.find((el) => el.textContent === 'ביקורים 40')!;
    expect(blue.style.background).toContain('--color-accent');
    expect(black.style.background, 'falls back to the class default — the dark box').toBe('');
  });

  it('the upper point is explained above it and the lower one below, so they cannot overlap', () => {
    const { a, b } = anchors();
    showSeriesTooltips([{ anchor: b, text: 'lower' }, { anchor: a, text: 'upper' }]);
    const shown = tips();
    const upper = shown.find((el) => el.textContent === 'upper')!;
    const lower = shown.find((el) => el.textContent === 'lower')!;
    // Anchor tops are 40 and 120. Above-of-40 must land higher than below-of-124.
    expect(parseFloat(upper.style.top)).toBeLessThan(40);
    expect(parseFloat(lower.style.top)).toBeGreaterThanOrEqual(124);
  });

  it('moving onto anything else puts the second box away', () => {
    // A stranded tooltip from the previous column is worse than none: it explains a point the
    // cursor has left. Every single-tooltip entry point clears the extras.
    const { a, b } = anchors();
    showSeriesTooltips([{ anchor: a, text: 'one' }, { anchor: b, text: 'two' }]);
    expect(tips().length).toBe(2);
    showTooltip(a, 'a bar somewhere else');
    expect(tips().length, 'only the shared slot survives').toBe(1);
    expect(tips()[0]!.textContent).toBe('a bar somewhere else');
  });

  it('never parses its content as markup', () => {
    // Load-bearing: this same pool shows bar and donut tooltips whose label is a PRODUCT NAME —
    // seller-authored text rendered to an admin.
    const { a } = anchors();
    showSeriesTooltips([{ anchor: a, text: '<img src=x onerror=alert(1)>' }]);
    const el = tips()[0]!;
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
