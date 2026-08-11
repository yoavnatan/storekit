import { escapeHtml } from './html-escape.js';
// Minimal, dependency-free inline-SVG bar chart — isomorphic (no node:fs) so
// the same function builds both the SSR-rendered initial chart (dashboard.astro,
// no flash-of-empty-chart on load) and the client-side re-render after a
// range-picker fetch (performance.ts), so the two can never visually drift
// apart. Deliberately not a charting library: the seller dashboard only ever
// needs a single bar series at a time.
export interface BarChartPoint {
  label: string;
  value: number;
  // Optional stable period key (e.g. '2026-07-15' / '2026-07') emitted as
  // data-key on the bar — lets a click handler map a bar back to its exact
  // day/month bucket (revenue chart → per-period product breakdown modal,
  // performance.ts) without re-parsing the human label.
  key?: string;
  // Optional tooltip label overriding `label` in the hover tooltip. Lets the
  // x-axis carry a short/truncated caption (e.g. a ranked store's short name)
  // while the tooltip reveals the full name — the admin exposure chart.
  tipLabel?: string;
  // Optional per-bar fill overriding the chart's `color` — e.g. the admin
  // exposure chart tints a store's bar differently when it runs a paid boost.
  color?: string;
}

export interface BarChartOptions {
  width?: number;
  height?: number;
  color?: string;
  valueFormatter?: (v: number) => string;
  emptyMessage?: string;
  // RTL (Hebrew): y-axis gutter on the right instead of the left. The value
  // scale then sits on the reading-start side, matching the page direction.
  rtl?: boolean;
  // Emit the entrance animation's classes (bars grow / line draws itself). Defaults
  // true, but on the seller + admin performance surfaces every SSR call passes false
  // and only the client's first paint passes true: the two render at different widths,
  // so whoever draws the FINAL geometry has to be the one that animates (see the note
  // above this file's <svg> tag, and performance.ts). A resize repaint passes false too,
  // so dragging the window doesn't replay it.
  animate?: boolean;
}

function escXml(s: string): string {
  return escapeHtml(s);
}

// Compact y-axis tick label (1200 → "1.2K") — keeps the axis gutter narrow and
// legible; the full/formatted value still shows in the hover tooltip.
function compactNum(v: number): string {
  if (v >= 1000) { const k = v / 1000; return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}K`; }
  return String(Math.round(v));
}

// Shared axis geometry + chrome for both chart types. The value-scale gutter is
// on the left (LTR) or right (RTL); the plot area fills the rest. 3 horizontal
// gridlines (0 / half / max) with a compact value label. Centralised so the bar
// and line charts stay identical. When the caller passes a real pixel width
// (client-side, measured from the container) the SVG renders 1:1 and these font
// sizes are exact px; at the SSR default width they scale slightly.
//
// padX is an outer margin on the side *opposite* the gutter so the plot
// (gridlines, first/last point) doesn't sit flush against the container wall —
// otherwise the chart looks like it bleeds off one edge while the gutter floats
// it off the other. labelGap is the small, constant space between the axis
// numbers and the plot.
const AXIS = { padTop: 12, padBottom: 26, padX: 10, labelGap: 7 };
// The y-axis gutter is sized to the actual value labels ("1.2K", "167", …) so
// the numbers sit `labelGap` from the plot no matter their magnitude — a fixed
// slab either clips big values or leaves big whitespace beside small ones (what
// looked disproportionate). ~6.2px per glyph at font-size 10, + gap + a small
// margin from the container edge.
function yGutter(max: number): number {
  const chars = Math.max(1, ...[0, 0.5, 1].map((t) => compactNum(max * t).length));
  return Math.round(chars * 6.2) + AXIS.labelGap + 5;
}
function plotGeom(width: number, rtl: boolean, gutter: number): { left: number; right: number; w: number } {
  const w = width - gutter - AXIS.padX;
  const left = rtl ? AXIS.padX : gutter;
  return { left, right: left + w, w };
}
// x-axis tick label. The first/last shown labels anchor to their inner edge
// (start/end) instead of centering, so an edge label can't overflow the viewBox
// and get clipped (the leftmost date was losing its leading "0"). This relies on
// the SVG carrying an explicit `direction:ltr` (buildBar/LineChartSvg) — a `dir`
// *attribute* is ignored for SVG text, so on an RTL page the neutral date/number
// glyphs would otherwise inherit rtl and flip `start`/`end`, clipping the edge
// labels off the wrong side.
function xLabelSvg(text: string, cx: number, i: number, n: number, height: number): string {
  const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
  return `<text x="${cx.toFixed(1)}" y="${height - 8}" font-size="11" text-anchor="${anchor}" fill="var(--color-muted)">${escXml(text)}</text>`;
}
function yAxisSvg(max: number, width: number, chartH: number, rtl: boolean, gutter: number): string {
  const g = plotGeom(width, rtl, gutter);
  // Labels sit just outside the plot edge with a small constant gap: in RTL the
  // gutter is on the right, so the label's inner (left) edge is `labelGap` past
  // the plot's right edge and grows outward (anchor start); LTR mirrors it. The
  // gutter is sized (yGutter) to fit the widest value, so growing outward never
  // clips the container — this is why the ltr direction fix matters (a bidi flip
  // would send `start` the wrong way and clip the number off the edge).
  const labelX = rtl ? g.right + AXIS.labelGap : g.left - AXIS.labelGap;
  const anchor = rtl ? 'start' : 'end';
  return [0, 0.5, 1].map((t) => {
    const y = AXIS.padTop + chartH * (1 - t);
    const grid = `<line x1="${g.left}" y1="${y.toFixed(1)}" x2="${g.right}" y2="${y.toFixed(1)}" stroke="var(--color-border)" stroke-width="1"${t === 0 ? '' : ' stroke-opacity="0.55"'}/>`;
    const label = `<text x="${labelX}" y="${(y + 3.5).toFixed(1)}" font-size="10" text-anchor="${anchor}" fill="var(--color-muted)">${escXml(compactNum(max * t))}</text>`;
    return grid + label;
  }).join('');
}

// Smooth curve through the points, as an SVG path `d` (monotone cubic /
// Fritsch–Carlson). Each segment is a cubic bézier whose control points come
// from slopes that are clamped so the curve can never overshoot a point's own
// value: a plain Catmull-Rom spline bulges past a local min/max, which here
// would dip the area fill below the zero baseline after a drop to 0 and invent
// peaks the data doesn't have. Flat runs and direction changes get a zero
// tangent, so the line stays soft but always passes exactly through the dots.
function smoothPathD(pts: Array<{ x: number; y: number }>): string {
  const n = pts.length;
  if (n < 2) return '';
  const start = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  if (n === 2) return `${start} L${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    slope.push(dx[i] === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx[i]);
  }
  // Initial tangents: the average of the two neighbouring slopes, flattened to 0
  // at a direction change (a peak/valley) so the curve turns there instead of
  // shooting past the point.
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i++) m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  m.push(slope[n - 2]);
  // Fritsch–Carlson clamp: keep each tangent pair inside the circle of radius 3
  // around its segment slope — the condition that guarantees monotonicity.
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  const segs = [];
  for (let i = 0; i < n - 1; i++) {
    const third = dx[i] / 3;
    const c1x = pts[i].x + third, c1y = pts[i].y + m[i] * third;
    const c2x = pts[i + 1].x - third, c2y = pts[i + 1].y - m[i + 1] * third;
    segs.push(`C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`);
  }
  return start + segs.join(' ');
}

export function buildBarChartSvg(points: BarChartPoint[], opts: BarChartOptions = {}): string {
  const width = opts.width ?? 640;
  const height = opts.height ?? 200;
  const color = opts.color ?? 'var(--color-primary)';
  const fmt = opts.valueFormatter ?? ((v: number) => String(v));
  const n = points.length;
  if (n === 0 || points.every((p) => p.value === 0)) {
    return `<p class="muted" style="font-size:0.85rem;text-align:center;padding:2.5rem 0;margin:0">${escXml(opts.emptyMessage ?? '')}</p>`;
  }

  const max = Math.max(...points.map((p) => p.value), 1);
  const rtl = opts.rtl ?? false;
  const animate = opts.animate ?? true;
  const chartH = height - AXIS.padTop - AXIS.padBottom;
  const gutter = yGutter(max);
  const geom = plotGeom(width, rtl, gutter);
  const slot = geom.w / n;
  const barW = Math.max(2, slot * 0.6);
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const axis = yAxisSvg(max, width, chartH, rtl, gutter);

  const bars = points.map((p, i) => {
    const x = geom.left + i * slot + (slot - barW) / 2;
    const h = (p.value / max) * chartH;
    const y = AXIS.padTop + (chartH - h);
    // Always label the last point, but suppress a regular tick sitting less than
    // one label-interval before it, so the forced last label can't overlap its
    // neighbour (e.g. a 14-day range showed "13/07" colliding with "14/07").
    const showLabel = i === n - 1 || (i % labelEvery === 0 && n - 1 - i >= labelEvery);
    const label = showLabel ? xLabelSvg(p.label, x + barW / 2, i, n, height) : '';
    // class/data-* power the custom hover tooltip (initChartTooltips() in
    // performance.ts). No <title>: it would stack a second native browser
    // tooltip on top of the custom one.
    const keyAttr = p.key ? ` data-key="${escXml(p.key)}"` : '';
    const anim = animate ? ` animate-bar-grow" style="animation-delay:${Math.min(i * 18, 400)}ms"` : '"';
    // A zero-value day draws no stub (height 0): a 1px min turned a run of empty
    // days into a dashed line sitting on top of the baseline gridline. A tiny
    // non-zero value still gets a 1px min so it stays visible.
    const barH = p.value === 0 ? 0 : Math.max(h, 1);
    return `<g><rect class="chart-bar${anim} x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2.5" fill="${p.color ?? color}" data-label="${escXml(p.tipLabel ?? p.label)}" data-value="${escXml(fmt(p.value))}"${keyAttr}></rect>${label}</g>`;
  }).join('');

  // preserveAspectRatio="none": stretch the viewBox to fill the container box
  // exactly (no letterbox/offset). Height is fixed so the vertical scale is always
  // 1 — axis text keeps its full pixel height; only horizontal metrics stretch, and
  // rendering at the measured container width (performance.ts) keeps that ratio ~1
  // so there's no visible distortion.
  //
  // `height:${height}px` as an inline STYLE, not just the height attribute: reset.css
  // sets `svg { height: auto }`, which outranks the attribute and derives the rendered
  // height from the viewBox ratio instead — so the SSR chart (fixed 640 viewBox in a
  // 597px card) came out 186.6px tall and the client's repaint at the measured width
  // came out 200px, and every chart visibly grew on the handoff. It also silently
  // squashed the axis text by the same 6%, which is exactly what the paragraph above
  // says cannot happen.
  //
  // style="direction:ltr" (not just the dir attribute, which SVG text ignores):
  // forces the axis text-anchors to resolve start=left / end=right even on an
  // RTL page, so the edge date/number labels can't bidi-flip and clip.
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escXml(opts.emptyMessage ?? 'chart')}" preserveAspectRatio="none" style="direction:ltr;height:${height}px">${axis}${bars}</svg>`;
}

// Line variant of buildBarChartSvg (same options + tooltip contract) — a soft
// area fill under a stroked smooth curve (smoothPathD) with a dot per point.
// Per-point full-height
// ── What a line chart is HOVERABLE on (owner, 2026-08-11) ───────────────────
// A tooltip used to appear anywhere inside the point's full-height column, so pointing at empty
// space near the top of the box explained a value drawn near the bottom of it — "לא על גבי כל
// הקונטיינר". A line chart's marks are the LINE and its DOTS, and those are now the only two
// things that answer a cursor.
//
// Both are invisible and both are generous, because a 2px stroke and a 2.4px dot are not pointing
// targets. The column rect stays in the markup — it is where the tooltip TEXT lives, read back by
// initChartTooltips — but it is `pointer-events="none"` and no longer a hit surface. Bar charts are
// untouched: there the bar IS the mark, and hovering it is already hovering the data.

/** Invisible pointing target over a dot. r=9 against the dot's 2.4 — comfortably clickable at a
 *  trackpad's precision without reaching the neighbouring point (columns are ~20px at 31 points). */
const hitDot = (x: number, y: number): string =>
  `<circle class="chart-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="transparent"></circle>`;

/** Invisible wide stroke tracing the same curve, so the LINE between two dots is hoverable too.
 *  `pointer-events="stroke"` and no fill: the area under the curve must not become a hit surface,
 *  which would quietly re-create the column it replaces. */
const hitLinePath = (d: string): string =>
  `<path class="chart-hit-line" d="${d}" fill="none" stroke="transparent" stroke-width="14" pointer-events="stroke"></path>`;

// transparent hit rects carry class="chart-bar" + data-label/data-value so the
// EXISTING initChartTooltips() wiring (performance.ts) lights up on hover with
// no extra code. The line draws itself in on render (animate-line-draw).
export function buildLineChartSvg(points: BarChartPoint[], opts: BarChartOptions = {}): string {
  const width = opts.width ?? 640;
  const height = opts.height ?? 200;
  const color = opts.color ?? 'var(--color-accent)';
  const fmt = opts.valueFormatter ?? ((v: number) => String(v));
  const n = points.length;
  if (n === 0 || points.every((p) => p.value === 0)) {
    return `<p class="muted" style="font-size:0.85rem;text-align:center;padding:2.5rem 0;margin:0">${escXml(opts.emptyMessage ?? '')}</p>`;
  }

  const max = Math.max(...points.map((p) => p.value), 1);
  const rtl = opts.rtl ?? false;
  const animate = opts.animate ?? true;
  const chartH = height - AXIS.padTop - AXIS.padBottom;
  const gutter = yGutter(max);
  const geom = plotGeom(width, rtl, gutter);
  // A line spans edge-to-edge (first point on the left plot edge, last on the
  // right), unlike bars which are band-centred in a slot — this fills the plot
  // width instead of leaving a half-slot gap at each end.
  const step = n > 1 ? geom.w / (n - 1) : 0;
  const baseline = AXIS.padTop + chartH;
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const axis = yAxisSvg(max, width, chartH, rtl, gutter);

  const xy = points.map((p, i) => {
    const x = n > 1 ? geom.left + i * step : geom.left + geom.w / 2;
    const y = AXIS.padTop + (chartH - (p.value / max) * chartH);
    return { x, y };
  });

  const curve = smoothPathD(xy);
  // Single point → no line to draw; fall back to just the dot + hit area. The
  // area reuses the exact same curve, then closes down to the baseline, so fill
  // and stroke can never drift apart.
  const areaPath = n > 1
    ? `<path d="${curve} L${xy[n - 1].x.toFixed(1)},${baseline.toFixed(1)} L${xy[0].x.toFixed(1)},${baseline.toFixed(1)} Z" fill="${color}" fill-opacity="0.08" stroke="none"/>`
    : '';
  const hitLine = n > 1 ? hitLinePath(curve) : '';
  const line = n > 1
    ? `<path class="chart-line${animate ? ' animate-line-draw' : ''}" pathLength="1" d="${curve}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    : '';

  // One group per point: the column rect (which now only CARRIES the tooltip text — see hitDot),
  // the hit circle, and the visible dot. Grouping lets pure CSS (.chart-point:hover .line-dot)
  // highlight a point's own dot while it is hovered, with no JS.
  const half = n > 1 ? step / 2 : geom.w / 2;
  const pointGroups = points.map((p, i) => {
    const pt = xy[i];
    // Hover column centred on the point, clamped to the plot so edge columns
    // don't spill past the frame.
    const rx = Math.max(geom.left, pt.x - half);
    const rw = Math.min(geom.right, pt.x + half) - rx;
    // See buildBarChartSvg: drop a regular tick within one interval of the
    // always-shown last label so they can't overlap.
    const showLabel = i === n - 1 || (i % labelEvery === 0 && n - 1 - i >= labelEvery);
    const label = showLabel ? xLabelSvg(p.label, pt.x, i, n, height) : '';
    return `<g class="chart-point"><rect class="chart-bar" pointer-events="none" x="${rx.toFixed(1)}" y="${AXIS.padTop}" width="${rw.toFixed(1)}" height="${chartH.toFixed(1)}" fill="transparent" data-label="${escXml(p.tipLabel ?? p.label)}" data-value="${escXml(fmt(p.value))}"></rect>${hitDot(pt.x, pt.y)}<circle class="line-dot" cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="2.4" fill="${color}"></circle>${label}</g>`;
  }).join('');

  // preserveAspectRatio="none" + style="direction:ltr" — see buildBarChartSvg.
  // Fills the container width exactly; the fixed height keeps text at full pixel
  // height; the explicit ltr direction keeps the axis labels from bidi-flipping
  // (and clipping) on an RTL page.
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escXml(opts.emptyMessage ?? 'chart')}" preserveAspectRatio="none" style="direction:ltr;height:${height}px">${axis}${areaPath}${line}${hitLine}${pointGroups}</svg>`;
}

export interface LineSeries {
  points: BarChartPoint[]; // x-aligned across series (same labels + length)
  color: string;
  fill?: boolean;   // soft area under this series (use for the primary/lower line)
  dashed?: boolean; // dashed static stroke for a secondary/envelope series
  label?: string;   // short name shown in the combined per-point tooltip
}

// Multi-series variant of buildLineChartSvg (same options + tooltip contract) —
// overlays N x-aligned series on one shared y-axis (e.g. total visits vs unique
// visitors, where the gap between the two lines is itself the insight). One
// hover column per x-index carries a combined data-value listing every series'
// value, so the EXISTING initChartTooltips() wiring (performance.ts) shows both
// at once with no extra code. series[0] is the primary: its dot is the tooltip
// anchor and it paints on top; a `dashed` series reads as the secondary
// envelope. All series are assumed the same length (callers pass summary.points
// mapped twice).
export function buildMultiLineChartSvg(series: LineSeries[], opts: BarChartOptions = {}): string {
  const width = opts.width ?? 640;
  const height = opts.height ?? 200;
  const fmt = opts.valueFormatter ?? ((v: number) => String(v));
  const clean = series.filter((s) => s.points.length > 0);
  const n = clean[0]?.points.length ?? 0;
  if (n === 0 || clean.every((s) => s.points.every((p) => p.value === 0))) {
    return `<p class="muted" style="font-size:0.85rem;text-align:center;padding:2.5rem 0;margin:0">${escXml(opts.emptyMessage ?? '')}</p>`;
  }

  const max = Math.max(1, ...clean.flatMap((s) => s.points.map((p) => p.value)));
  const rtl = opts.rtl ?? false;
  const animate = opts.animate ?? true;
  const chartH = height - AXIS.padTop - AXIS.padBottom;
  const gutter = yGutter(max);
  const geom = plotGeom(width, rtl, gutter);
  const step = n > 1 ? geom.w / (n - 1) : 0;
  const baseline = AXIS.padTop + chartH;
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const axis = yAxisSvg(max, width, chartH, rtl, gutter);

  const xOf = (i: number): number => (n > 1 ? geom.left + i * step : geom.left + geom.w / 2);
  const yOf = (v: number): number => AXIS.padTop + (chartH - (v / max) * chartH);

  // Paint reversed so series[0] (the primary) ends up visually on top.
  const layers = [...clean].reverse().map((s) => {
    const xy = s.points.map((p, i) => ({ x: xOf(i), y: yOf(p.value) }));
    const curve = smoothPathD(xy);
    const area = s.fill && n > 1
      ? `<path d="${curve} L${xy[n - 1].x.toFixed(1)},${baseline.toFixed(1)} L${xy[0].x.toFixed(1)},${baseline.toFixed(1)} Z" fill="${s.color}" fill-opacity="0.08" stroke="none"/>`
      : '';
    // A dashed secondary skips the .chart-line class (whose CSS forces
    // stroke-dasharray:1 for the draw animation) so its inline dash survives —
    // AND skips pathLength="1" (which normalises the whole path to length 1, so
    // a "4 3" dasharray would cover the entire path and render solid). The
    // primary keeps pathLength="1" because the draw keyframe animates its
    // dashoffset across that normalised length.
    const cls = s.dashed ? '' : `chart-line${animate ? ' animate-line-draw' : ''}`;
    const dash = s.dashed ? ' stroke-dasharray="4 3" stroke-opacity="0.75"' : ' pathLength="1"';
    const line = n > 1
      ? `<path class="${cls}"${dash} d="${curve}" fill="none" stroke="${s.color}" stroke-width="${s.dashed ? 1.5 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`
      : '';
    // Every series gets its own hit stroke — pointing at the dashed envelope has to work exactly
    // as well as pointing at the solid line, and it is drawn thinner.
    return area + line + (n > 1 ? hitLinePath(curve) : '');
  }).join('');

  const primary = clean[0];
  const half = n > 1 ? step / 2 : geom.w / 2;
  const pointGroups = Array.from({ length: n }, (_, i) => {
    const px = xOf(i);
    const rx = Math.max(geom.left, px - half);
    const rw = Math.min(geom.right, px + half) - rx;
    // Combined tooltip value: "<label> <value> · <label> <value>" for every series. Kept as the
    // FALLBACK only — the client builds one row per series from the dots below (a flat sentence in
    // one colour was the reported confusion), and this is what an older deployed client, or a
    // browser that somehow finds no dots, still reads.
    const combined = clean.map((s) => `${s.label ? s.label + ' ' : ''}${fmt(s.points[i]?.value ?? 0)}`).join(' · ');
    const showLabel = i === n - 1 || (i % labelEvery === 0 && n - 1 - i >= labelEvery);
    const label = showLabel ? xLabelSvg(primary.points[i].label, px, i, n, height) : '';
    // One dot per series; primary first so it's initChartTooltips' anchor.
    //
    // Each dot carries its OWN series name, value and dash state, and is its own tooltip's ANCHOR —
    // the two tooltips appear beside the two points rather than as one box explaining both. Not a
    // second payload on the column rect: the dot is already where the series' colour lives
    // (`fill`), so a tooltip anchored to it cannot end up describing one line in another's colour.
    const dots = clean.map((s) => {
      const dy = yOf(s.points[i]?.value ?? 0);
      return hitDot(px, dy)
        + `<circle class="line-dot" cx="${px.toFixed(1)}" cy="${dy.toFixed(1)}" r="2.4" fill="${s.color}" data-label="${escXml(s.label ?? '')}" data-value="${escXml(fmt(s.points[i]?.value ?? 0))}"${s.dashed ? ' data-dashed="1"' : ''}></circle>`;
    }).join('');
    return `<g class="chart-point"><rect class="chart-bar" pointer-events="none" x="${rx.toFixed(1)}" y="${AXIS.padTop}" width="${rw.toFixed(1)}" height="${chartH.toFixed(1)}" fill="transparent" data-label="${escXml(primary.points[i].label)}" data-value="${escXml(combined)}"></rect>${dots}${label}</g>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escXml(opts.emptyMessage ?? 'chart')}" preserveAspectRatio="none" style="direction:ltr;height:${height}px">${axis}${layers}${pointGroups}</svg>`;
}

export interface PieSlice { label: string; value: number; color: string }

// Donut chart via the stroke-dasharray-on-circle technique (no arc-path math,
// stays crisp at any size). Isomorphic like buildBarChartSvg — reused by the
// revenue-breakdown modal (performance.ts). The whole ring spins into place on
// render (animate-donut-in). Legend is rendered by the caller from the same
// slices array (kept out so it can be styled with the surrounding modal).
export function buildDonutChartSvg(slices: PieSlice[], opts: { size?: number; thickness?: number } = {}): string {
  const size = opts.size ?? 180;
  const total = slices.reduce((s, sl) => s + Math.max(0, sl.value), 0);
  const r = size / 2;
  const stroke = opts.thickness ?? Math.round(size * 0.17);
  const innerR = r - stroke / 2; // radius of the stroked circle's centreline
  const c = 2 * Math.PI * innerR;

  if (total <= 0) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="chart"><circle cx="${r}" cy="${r}" r="${innerR.toFixed(2)}" fill="none" stroke="var(--color-border)" stroke-width="${stroke}"/></svg>`;
  }

  // Segments touch edge-to-edge (no gaps) so the ring is continuous and its end
  // meets its start — the different stroke colours are what separate the slices.
  let offset = 0;
  const rings = slices.map((sl) => {
    const frac = Math.max(0, sl.value) / total;
    const dash = frac * c;
    // data-* power the custom hover tooltip (segTip in performance.ts) — value
    // left raw for the client to run through formatPrice, keeping this builder
    // isomorphic/currency-agnostic. class="donut-seg" is the tooltip +
    // hover-highlight hook. Deliberately NO <title>: it would trigger a second,
    // native browser tooltip on top of the custom one (the legend carries the
    // same data for a11y/no-JS).
    const seg = `<circle class="donut-seg" cx="${r}" cy="${r}" r="${innerR.toFixed(2)}" fill="none" stroke="${escXml(sl.color)}" stroke-width="${stroke}" stroke-dasharray="${dash.toFixed(2)} ${(c - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${r} ${r})" data-label="${escXml(sl.label)}" data-pct="${Math.round(frac * 100)}" data-amount="${sl.value}"></circle>`;
    offset += dash;
    return seg;
  }).join('');

  // animate-donut-in spins + scales the whole ring into place on render (a CSS
  // transform on the <svg> root, safe because it composes with — rather than
  // overrides — the SVG transform attribute on the inner <circle>s).
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="chart" dir="ltr" class="animate-donut-in" style="transform-origin:center">${rings}</svg>`;
}
