// Pure, isomorphic date-range helpers for the advertising dashboards' range
// picker (CURRENT_TASK.md → סשן ב׳). No node imports, so client scripts can use
// it too. Deliberately NOT reusing performance.ts's private presetRange (that's
// a client-only closure inside a Session-A file) — this is the shared home for
// the same idea, used by the ad SSR panel, the ad API, and the picker client.

export type AdRangePreset = 'today' | '7d' | '30d' | 'thisMonth' | 'custom' | 'lifetime';
export const AD_RANGE_PRESETS: readonly AdRangePreset[] = ['today', '7d', '30d', 'thisMonth', 'custom', 'lifetime'];

/** Local-calendar ISO (YYYY-MM-DD) — NOT toISOString(), which serialises in UTC
 *  and in a +UTC timezone (Israel) shifts a local-midnight date back a day. */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Parse a YYYY-MM-DD string as a LOCAL date (new Date('2026-01-01') would parse
 *  it as UTC midnight, off-by-one in +UTC zones). */
function parseISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Inclusive whole-day count between two ISO dates (from ≤ to). Min 1. */
export function daysInRangeInclusive(fromISO: string, toISO: string): number {
  const ms = parseISO(toISO).getTime() - parseISO(fromISO).getTime();
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

/** Resolve a preset to a concrete {from,to}. `custom` returns null (caller supplies
 *  the dates). `today` param is injectable for deterministic tests. */
export function presetRange(preset: AdRangePreset, today: Date = new Date()): { from: string; to: string } | null {
  const to = toISODate(today);
  if (preset === 'today') return { from: to, to };
  if (preset === '7d' || preset === '30d') {
    const days = preset === '7d' ? 7 : 30;
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    return { from: toISODate(from), to };
  }
  if (preset === 'thisMonth') {
    return { from: toISODate(new Date(today.getFullYear(), today.getMonth(), 1)), to };
  }
  // custom → caller supplies dates. lifetime → NOT a shared window: each campaign
  // reports over its own run period (ad-metrics.ts#campaignLifetimeStats), so
  // there is no single {from,to} to return here.
  return null;
}

/** The equal-length window immediately before [from,to] — for period-over-period comparison. */
export function previousPeriod(fromISO: string, toISO: string): { from: string; to: string } {
  const len = daysInRangeInclusive(fromISO, toISO);
  const prevTo = new Date(parseISO(fromISO));
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (len - 1));
  return { from: toISODate(prevFrom), to: toISODate(prevTo) };
}

/** Coerce untrusted from/to (e.g. custom date inputs) into a valid range. Swaps
 *  reversed dates, caps length at 366 days, falls back to the 7-day preset when
 *  either date is missing/malformed. */
export function coerceRange(fromRaw: unknown, toRaw: unknown, today: Date = new Date()): { from: string; to: string } {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  let from = typeof fromRaw === 'string' && iso.test(fromRaw) ? fromRaw : '';
  let to = typeof toRaw === 'string' && iso.test(toRaw) ? toRaw : '';
  if (!from || !to) return presetRange('7d', today)!;
  if (from > to) [from, to] = [to, from];
  if (daysInRangeInclusive(from, to) > 366) {
    const capped = new Date(parseISO(to));
    capped.setDate(capped.getDate() - 365);
    from = toISODate(capped);
  }
  return { from, to };
}

/** Compact day.month caption from an ISO date, e.g. "2026-07-08" → "8.7". */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${Number(d)}.${Number(m)}`;
}

/** Resolve the ad range-picker's query params to a concrete window, or undefined
 *  for the per-campaign lifetime view (no preset, or preset=lifetime). Shared by
 *  the seller + admin ad-campaign routes so the window-vs-lifetime decision and
 *  the `7d` fallback live in one place and can't drift between the two. */
export function resolveAdRange(params: URLSearchParams): { from: string; to: string } | undefined {
  const presetRaw = params.get('preset') as AdRangePreset | null;
  const windowed = (presetRaw !== null && presetRaw !== 'lifetime') || params.has('from');
  if (!windowed) return undefined;
  const preset: AdRangePreset = AD_RANGE_PRESETS.includes(presetRaw as AdRangePreset) ? presetRaw! : '7d';
  return preset === 'custom' ? coerceRange(params.get('from'), params.get('to')) : presetRange(preset)!;
}
