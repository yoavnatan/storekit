// Minimal, dependency-free inline-SVG bar chart — isomorphic (no node:fs) so
// the same function builds both the SSR-rendered initial chart (dashboard.astro,
// no flash-of-empty-chart on load) and the client-side re-render after a
// range-picker fetch (performance.ts), so the two can never visually drift
// apart. Deliberately not a charting library: the seller dashboard only ever
// needs a single bar series at a time.
export interface BarChartPoint { label: string; value: number }

export interface BarChartOptions {
  width?: number;
  height?: number;
  color?: string;
  valueFormatter?: (v: number) => string;
  emptyMessage?: string;
}

function escXml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  const padBottom = 22;
  const padTop = 10;
  const chartH = height - padBottom - padTop;
  const slot = width / n;
  const barW = Math.max(2, slot * 0.6);
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  const bars = points.map((p, i) => {
    const x = i * slot + (slot - barW) / 2;
    const h = (p.value / max) * chartH;
    const y = padTop + (chartH - h);
    const showLabel = i % labelEvery === 0 || i === n - 1;
    const label = showLabel
      ? `<text x="${(x + barW / 2).toFixed(1)}" y="${height - 6}" font-size="9" text-anchor="middle" fill="var(--color-muted)">${escXml(p.label)}</text>`
      : '';
    return `<g><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="2.5" fill="${color}"><title>${escXml(p.label)}: ${escXml(fmt(p.value))}</title></rect>${label}</g>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escXml(opts.emptyMessage ?? 'chart')}" preserveAspectRatio="xMidYMid meet" dir="ltr">${bars}</svg>`;
}
