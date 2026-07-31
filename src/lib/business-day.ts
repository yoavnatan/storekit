/**
 * The ONE answer to "which calendar day/month did this happen on?".
 *
 * Every seller- and admin-facing report buckets money by day or month, and until
 * this module existed there were THREE different answers to that question in the
 * codebase, all of them defensible on their own:
 *
 *   1. date-range.ts   — the runtime's LOCAL calendar (correct intent, wrong scope:
 *                        "local" is the server's timezone, which is UTC in prod).
 *   2. dashboard.astro — a hand-rolled copy of the same local-calendar formatter.
 *   3. seller-performance.ts — `toISOString().slice(0,10)`, i.e. UTC.
 *
 * Israel is UTC+2/+3, so (3) disagreed with (1) and (2) for every order placed
 * between local midnight and 02:00/03:00: the seller's daily chart filed those
 * sales under the PREVIOUS day, and an order placed just after midnight on the 1st
 * of the month fell out of "this month" entirely. The monthly total stayed right,
 * which is exactly why nobody would ever have noticed.
 *
 * The fix is not "use local time" — a production server runs on UTC, so local time
 * would put the same bug back with a different label. A marketplace that sells in
 * ILS to Israeli buyers has ONE business calendar, and it has to be named out loud.
 *
 * Two families of function live here, and mixing them up is the whole bug:
 *
 *   businessDayISO / businessMonthKey — for a real INSTANT (an order's createdAt).
 *     Answers "which business day does this moment fall on", honouring DST.
 *
 *   calendarDayISO / calendarMonthKey — for a synthetic date CURSOR used to walk a
 *     range and lay out a chart's x-axis. Those Dates are already plain calendar
 *     dates with no timezone meaning, so they are read back in UTC, unchanged.
 *
 * No I/O and no config imports, so this is safe to use from client bundles too.
 */

/** The platform's business calendar. Every report's "day" and "month" mean this zone,
 *  regardless of where the server or the viewer happens to be. */
export const BUSINESS_TIMEZONE = 'Asia/Jerusalem';

const businessParts = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Memo of instant → business day. `formatToParts` is cheap once and expensive in
// a loop: the admin performance tab asks the same ~200 order timestamps this
// question once per store, so one dashboard render made ~9,000 Intl calls —
// measured on the real data at 57ms uncached against 2ms memoised. The mapping is
// a pure function of the instant, so a hit is always as correct as a miss —
// including across a DST boundary, which is a property of the instant, not of
// when we ask.
// Capped and cleared wholesale rather than evicted one at a time: a report walks
// a bounded set of timestamps, so the cap is a leak guard, not a hit-rate knob.
const MAX_DAY_CACHE = 20_000;
const dayCache = new Map<number, string>();

/** 'YYYY-MM-DD' for the business day this instant falls on. */
export function businessDayISO(d: Date): string {
  const t = d.getTime();
  const hit = dayCache.get(t);
  if (hit !== undefined) return hit;

  let year = '', month = '', day = '';
  for (const p of businessParts.formatToParts(d)) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
  }
  const iso = `${year}-${month}-${day}`;

  if (dayCache.size >= MAX_DAY_CACHE) dayCache.clear();
  dayCache.set(t, iso);
  return iso;
}

/** 'YYYY-MM' for the business month this instant falls on. */
export function businessMonthKey(d: Date): string {
  return businessDayISO(d).slice(0, 7);
}

/** Today's business day as 'YYYY-MM-DD' — the default "to" of every range picker. */
export function businessTodayISO(now: Date = new Date()): string {
  return businessDayISO(now);
}

/** The 1st of the business month containing `iso` — the default "from" of the
 *  "this month" preset, derived from the same calendar the buckets use. */
export function businessMonthStartISO(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** 'YYYY-MM-DD' of a synthetic calendar cursor (axis enumeration only — see the
 *  file header). NOT for order timestamps: it reads the date in UTC. */
export function calendarDayISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM' of a synthetic calendar cursor (axis enumeration only). */
export function calendarMonthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** Is this business day inside the inclusive range? Both bounds are business-day
 *  strings, so this is a plain lexicographic compare — no instant arithmetic, and
 *  therefore nothing for a DST transition to shift. */
export function dayInRange(dayISO: string, fromISO: string, toISO: string): boolean {
  return dayISO >= fromISO && dayISO <= toISO;
}
