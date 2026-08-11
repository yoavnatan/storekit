// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { buildMultiLineChartSvg } from '../src/lib/chart-svg.js';
import { showTooltip, showTooltipRows, hideTooltip } from '../src/scripts/tooltip.js';

/**
 * The visits chart overlays two series — unique visitors and total visits — and its hover tooltip
 * used to flatten them into ONE sentence in ONE colour ("מבקרים ייחודיים 12 · ביקורים 40"), tinted
 * to the accent, which is one of the two series' own colour. Both numbers therefore read as the
 * same thing that only one of them was (owner, 2026-08-11).
 *
 * Two halves have to hold for the fix, and they live in different files, which is why this test
 * drives them together: the SVG has to carry each series' name and value ON THE DOT that already
 * holds its colour, and the tooltip has to turn those into rows without ever parsing markup.
 */
const SERIES = [
  { points: [{ label: '01/08', value: 12 }, { label: '02/08', value: 30 }], color: 'var(--color-accent)', fill: true, label: 'מבקרים ייחודיים' },
  { points: [{ label: '01/08', value: 40 }, { label: '02/08', value: 91 }], color: 'var(--color-muted)', dashed: true, label: 'ביקורים' },
];

function firstPointDots(): HTMLElement[] {
  document.body.innerHTML = `<div id="chart">${buildMultiLineChartSvg(SERIES, { animate: false })}</div>`;
  const group = document.querySelector('.chart-point');
  expect(group, 'the chart drew a hover column').not.toBeNull();
  return [...group!.querySelectorAll<HTMLElement>('.line-dot[data-label]')];
}

describe('the visits chart names each series on its own dot', () => {
  it('every series gets a dot carrying its label, value and colour', () => {
    const dots = firstPointDots();
    expect(dots.length, 'one dot per series, each identified').toBe(2);
    expect(dots.map((d) => d.getAttribute('data-label'))).toEqual(['מבקרים ייחודיים', 'ביקורים']);
    expect(dots.map((d) => d.getAttribute('data-value'))).toEqual(['12', '40']);
    // The colour comes off the dot rather than from a second payload, so a tooltip built from the
    // dots cannot describe one line in the other's colour.
    expect(dots.map((d) => d.getAttribute('fill'))).toEqual(['var(--color-accent)', 'var(--color-muted)']);
    expect(dots[1]!.getAttribute('data-dashed'), 'the dashed series says so').toBe('1');
    expect(dots[0]!.getAttribute('data-dashed'), 'the solid one does not').toBeNull();
  });

  it('the flat one-line value survives as the fallback for an older client', () => {
    document.body.innerHTML = `<div>${buildMultiLineChartSvg(SERIES, { animate: false })}</div>`;
    const rect = document.querySelector('.chart-point .chart-bar');
    expect(rect?.getAttribute('data-value')).toBe('מבקרים ייחודיים 12 · ביקורים 40');
  });

  it('a single-series line chart is left alone', () => {
    // Only a multi-series chart has anything to separate; the orders chart and the per-product
    // views chart must keep the plain tooltip rather than grow a one-row table.
    document.body.innerHTML = `<div>${buildMultiLineChartSvg([SERIES[0]!], { animate: false })}</div>`;
    // Per hover COLUMN, not per chart — a two-point chart has two columns either way, and it is the
    // count inside one column that decides whether the tooltip splits into rows.
    const dots = document.querySelector('.chart-point')!.querySelectorAll('.line-dot[data-label]');
    expect(dots.length).toBe(1);
  });
});

describe('showTooltipRows', () => {
  beforeEach(() => { document.body.innerHTML = ''; hideTooltip(); });

  const tip = (): HTMLElement => document.querySelector<HTMLElement>('.dash-tooltip')!;

  it('renders one row per series, each with its own swatch', () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    showTooltipRows(anchor, '01/08', [
      { label: 'מבקרים ייחודיים', value: '12', color: 'var(--color-accent)' },
      { label: 'ביקורים', value: '40', color: 'var(--color-muted)', dashed: true },
    ]);
    const el = tip();
    expect(el.textContent).toContain('01/08');
    expect(el.textContent).toContain('מבקרים ייחודיים 12');
    expect(el.textContent).toContain('ביקורים 40');

    const swatches = el.querySelectorAll<HTMLElement>('span[style]');
    expect(swatches.length, 'a mark per row').toBe(2);
    // Different marks, not the same one twice — the whole point. Solid fill vs dashed rule, and two
    // different hues behind them.
    expect(swatches[0]!.style.background).toContain('--color-accent');
    expect(swatches[1]!.style.background).toBe('transparent');
    expect(swatches[1]!.style.borderTop).toContain('--color-muted');
    expect(swatches[1]!.style.borderTop).toContain('dashed');
  });

  it('takes no series colour of its own', () => {
    // The bug was a tooltip painted in ONE series' colour while describing two. A multi-series
    // tooltip has to stay neutral; the swatches are what carry colour now.
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    showTooltip(anchor, 'anything', 'var(--color-accent)');   // leave the shared node tinted…
    showTooltipRows(anchor, '01/08', [
      { label: 'a', value: '1', color: 'var(--color-accent)' },
      { label: 'b', value: '2', color: 'var(--color-muted)' },
    ]);
    expect(tip().style.background, 'the previous caller’s tint is cleared').toBe('');
  });

  it('never parses its content as markup', () => {
    // Load-bearing, not stylistic: this SAME shared node shows bar and donut tooltips whose label
    // is a PRODUCT NAME — seller-authored text rendered to an admin. innerHTML here would be an XSS
    // sink reachable by naming a product.
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    showTooltipRows(anchor, '<img src=x onerror=alert(1)>', [
      { label: '<script>alert(2)</script>', value: '<b>3</b>', color: 'var(--color-accent)' },
    ]);
    const el = tip();
    expect(el.querySelector('img'), 'no element was parsed out of the title').toBeNull();
    expect(el.querySelector('script'), 'nor out of a label').toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.textContent).toContain('<script>alert(2)</script>');
  });
});
