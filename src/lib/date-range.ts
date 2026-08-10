// Pure, isomorphic date-range helpers for the advertising dashboards' range
// picker (CURRENT_TASK.md → סשן ב׳). No node imports, so client scripts can use
// it too. Deliberately NOT reusing performance.ts's private presetRange (that's
// a client-only closure inside a Session-A file) — this is the shared home for
// the same idea, used by the ad SSR panel, the ad API, and the picker client.

import { businessDayISO, businessMonthStartISO, calendarDayISO, isDayISO } from './business-day.js';

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

/** Shift a 'YYYY-MM-DD' by whole days. Pure calendar arithmetic done in UTC — the
 *  input carries no time-of-day, so there is no local midnight for a DST change to
 *  move and the result is the same in every timezone. */
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return calendarDayISO(shifted);
}

/** Inclusive whole-day count between two ISO dates (from ≤ to). Min 1. */
export function daysInRangeInclusive(fromISO: string, toISO: string): number {
  const ms = parseISO(toISO).getTime() - parseISO(fromISO).getTime();
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

/** Resolve a preset to a concrete {from,to}. `custom` returns null (caller supplies
 *  the dates). `today` param is injectable for deterministic tests. */
export function presetRange(preset: AdRangePreset, today: Date = new Date()): { from: string; to: string } | null {
  // "Today" is the BUSINESS day (business-day.ts), not the runtime's — on a
  // production server the runtime's local calendar is UTC, which rolls the date
  // over at 02:00/03:00 Israel time and would hand back the wrong day to a seller
  // checking their numbers late at night. Every other bound below is derived from
  // this string by calendar arithmetic, so the whole range stays on one calendar.
  const to = businessDayISO(today);
  if (preset === 'today') return { from: to, to };
  if (preset === '7d' || preset === '30d') {
    const days = preset === '7d' ? 7 : 30;
    return { from: addDaysISO(to, -(days - 1)), to };
  }
  if (preset === 'thisMonth') {
    return { from: businessMonthStartISO(to), to };
  }
  // custom → caller supplies dates. lifetime → NOT a shared window: each campaign
  // reports over its own run period (ad-metrics.ts#campaignLifetimeStats), so
  // there is no single {from,to} to return here.
  return null;
}

/**
 * The named windows a TOOLBAR range picker offers — the money journal's and the Alerts tab's.
 *
 * Separate from `AdRangePreset` on purpose, and the difference is not cosmetic. That vocabulary
 * carries `custom` and `lifetime`, which are answers to an advertising question ("report each
 * campaign over its own run period"); a journal has no such thing and offering it would be an
 * option that cannot mean anything. What a toolbar needs is the opposite: the three or four
 * windows someone actually asks for, reachable in one click.
 *
 * Added 2026-08-07 — the money journal's picker was two empty date inputs and nothing else, so
 * "what happened today" cost two calendar interactions and knowing today's date (owner).
 *
 * The order is deliberate: narrowest first, because the narrow ones are the ones asked for in a
 * hurry. The custom inputs stay beneath them for everything these do not cover.
 */
export type QuickRangeId = 'today' | 'thisWeek' | 'thisMonth' | '30d';
export const QUICK_RANGE_PRESETS: readonly { id: QuickRangeId; label: string }[] = [
  { id: 'today', label: 'היום' },
  { id: 'thisWeek', label: 'השבוע' },
  { id: 'thisMonth', label: 'החודש' },
  { id: '30d', label: '30 יום' },
];

/**
 * Resolve a toolbar preset to concrete bounds.
 *
 * Every bound is derived by calendar arithmetic from ONE business-day string, never from a fresh
 * `Date` per bound — the rule the seller performance picker learned the hard way: building each
 * end from the runtime's local clock computes "this month" against the browser's timezone while
 * the server buckets rows against the business calendar, and the range silently gains or loses a
 * day at each end.
 */
export function quickRange(id: QuickRangeId, today: Date = new Date()): { from: string; to: string } {
  const to = businessDayISO(today);
  if (id === 'today') return { from: to, to };
  if (id === 'thisWeek') {
    // Sunday-start, the Israeli week. `getUTCDay` on the parsed calendar date: a bare date string
    // carries no zone, so this is the weekday of `to` itself and not of some instant near it.
    const weekday = new Date(`${to}T00:00:00Z`).getUTCDay();
    return { from: addDaysISO(to, -weekday), to };
  }
  if (id === 'thisMonth') return { from: businessMonthStartISO(to), to };
  return { from: addDaysISO(to, -29), to };
}

/**
 * The seven-preset range used by the surfaces a seller reads a PERIOD off — the performance tab
 * and the reports tab. A superset of `QuickRangeId` (it adds the three rolling windows and, the
 * one that matters most to a bookkeeper, `lastMonth`).
 *
 * **Promoted here on 2026-08-10, and that is the point of the entry.** This was a private closure
 * inside `scripts/dashboard/performance.ts`; the header of this file recorded the decision not to
 * reuse it and to grow a second idea of "preset → bounds" here instead. Two was already one too
 * many, and a third (the reports tab needs `lastMonth`, which `quickRange` has no name for) would
 * have made the failure mode concrete: two tabs in the same dashboard, both saying "החודש שעבר",
 * disagreeing about which days that is. So the fullest of them moved out and the caller it came
 * from now imports it.
 *
 * Every bound is calendar arithmetic on ONE business-day string, never a fresh `Date` per bound —
 * see `quickRange` above for what that mistake cost when the seller's laptop was on another
 * timezone.
 */
export type PeriodPreset = 'today' | 'thisWeek' | 'thisMonth' | 'lastMonth' | '7d' | '30d' | '90d';
export const PERIOD_PRESETS: readonly PeriodPreset[] = ['today', 'thisWeek', 'thisMonth', 'lastMonth', '7d', '30d', '90d'];

/** The i18n key each preset's label lives under. Here rather than in each picker, because there
 *  are three of them now (the performance dropdown, the reports dropdown, and the reports panel's
 *  server-rendered initial label) and a preset whose name differs between two tabs of the same
 *  dashboard is the drift `periodRange` moved here to end. */
export const PERIOD_PRESET_LABEL_KEY: Record<PeriodPreset, string> = {
  today: 'perfPresetToday',
  thisWeek: 'perfPresetThisWeek',
  thisMonth: 'perfPresetThisMonth',
  lastMonth: 'perfPresetLastMonth',
  '7d': 'perfPreset7d',
  '30d': 'perfPreset30d',
  '90d': 'perfPreset90d',
};

export function periodRange(preset: string, today: Date = new Date()): { from: string; to: string } {
  const to = businessDayISO(today);
  if (preset === 'today') return { from: to, to };
  if (preset === 'thisWeek') {
    const weekday = new Date(`${to}T00:00:00Z`).getUTCDay();
    return { from: addDaysISO(to, -weekday), to };
  }
  if (preset === '7d' || preset === '30d' || preset === '90d') {
    const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
    return { from: addDaysISO(to, -(days - 1)), to };
  }
  if (preset === 'thisMonth') return { from: businessMonthStartISO(to), to };
  if (preset === 'lastMonth') {
    // The day before this month's 1st is the last day of the previous one.
    const end = addDaysISO(businessMonthStartISO(to), -1);
    return { from: businessMonthStartISO(end), to: end };
  }
  return { from: to, to };
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
  // A real day, not merely a ten-character one: `2026-02-30` has the shape and no meaning, and the
  // fallback below is the right answer for it (business-day.ts#isDayISO says why this matters).
  let from = typeof fromRaw === 'string' && isDayISO(fromRaw) ? fromRaw : '';
  let to = typeof toRaw === 'string' && isDayISO(toRaw) ? toRaw : '';
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
