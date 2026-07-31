import { describe, it, expect } from 'vitest';
import { buildBarChartSvg, buildLineChartSvg, buildMultiLineChartSvg, type BarChartPoint } from '../src/lib/chart-svg.js';

const pts = (values: number[]): BarChartPoint[] => values.map((v, i) => ({ label: `d${i}`, value: v }));

// The plot area for the default 200px height (AXIS.padTop 12 → baseline 174).
const PLOT_TOP = 12;
const PLOT_BOTTOM = 174;

function pathD(svg: string, cls = 'chart-line'): string {
  const m = svg.match(new RegExp(`class="${cls}[^"]*"[^>]*d="([^"]+)"`));
  return m?.[1] ?? '';
}
function allY(d: string): number[] {
  return [...d.matchAll(/[-\d.]+,([-\d.]+)/g)].map((m) => Number(m[1]));
}

describe('chart-svg smooth line', () => {
  it('curves between points instead of drawing straight segments', () => {
    const d = pathD(buildLineChartSvg(pts([3, 9, 4, 11, 6])));
    expect(d).toContain('C');
    expect(d).not.toContain(' L');
  });

  // The monotone (Fritsch–Carlson) clamp is the whole reason this isn't a plain
  // Catmull-Rom spline: an overshooting curve would push the stroke — and the
  // area fill under it — past the baseline on a drop to zero, painting revenue
  // below zero. Spiky data is the case that provokes it.
  it('never overshoots the plot area, even on spikes and drops to zero', () => {
    const d = pathD(buildLineChartSvg(pts([0, 0, 12, 3, 0, 40, 41, 5, 0, 0, 7])));
    const ys = allY(d);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(PLOT_TOP);
    expect(Math.max(...ys)).toBeLessThanOrEqual(PLOT_BOTTOM);
  });

  // Fill and stroke are built from the same `d` prefix — if they ever drift the
  // shaded area stops matching the line it shades.
  it('builds the area fill from the same curve as the stroke', () => {
    const svg = buildLineChartSvg(pts([2, 8, 5, 9]));
    const line = pathD(svg);
    const area = svg.match(/<path d="([^"]+)" fill="[^"]*" fill-opacity/)?.[1] ?? '';
    expect(area.startsWith(line)).toBe(true);
    expect(area.endsWith('Z')).toBe(true);
  });

  // The entrance animation relies on pathLength="1" normalising the curve, so
  // one keyframe (dashoffset 1 → 0) draws any point count.
  it('keeps the draw-in animation hooks on the curve', () => {
    const svg = buildLineChartSvg(pts([1, 4, 2]));
    expect(svg).toContain('class="chart-line animate-line-draw"');
    expect(svg).toContain('pathLength="1"');
    expect(buildLineChartSvg(pts([1, 4, 2]), { animate: false })).not.toContain('animate-line-draw');
  });

  // reset.css sets `svg { height: auto }`, which beats the height ATTRIBUTE and derives
  // the rendered height from the viewBox ratio. The server's chart uses a fixed 640-unit
  // viewBox and the client repaints at the container's measured width, so without an
  // inline height the two render at different heights (measured: 186.6px vs 200px) and
  // every chart jumps taller the moment the client takes over.
  it('pins the rendered height inline on every chart type', () => {
    const points = pts([1, 5, 3]);
    const series = [{ points, color: 'red' }];
    for (const svg of [buildBarChartSvg(points), buildLineChartSvg(points), buildMultiLineChartSvg(series)]) {
      expect(svg).toContain('height:200px');
    }
    expect(buildBarChartSvg(points, { height: 140 })).toContain('height:140px');
  });

  it('smooths every series of a multi-line chart', () => {
    const svg = buildMultiLineChartSvg([
      { points: pts([1, 6, 2, 7]), color: 'red', fill: true },
      { points: pts([3, 8, 4, 9]), color: 'grey', dashed: true },
    ]);
    // Two curves: the solid primary and the dashed secondary (no chart-line class).
    expect([...svg.matchAll(/<path class="[^"]*"[^>]*d="M[^"]*C/g)]).toHaveLength(2);
  });
});
