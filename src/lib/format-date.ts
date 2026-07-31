import { BUSINESS_TIMEZONE } from './business-day.js';

// Isomorphic (no fs/DOM) — safe to import from both Astro server frontmatter
// and browser-bundled client scripts, unlike the DOM-dependent helpers below.
export function formatHeDateTime(iso: string): string {
  return new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * The three below render an instant in the PLATFORM's business calendar, not the
 * runtime's (business-day.ts owns that zone). Anywhere a timestamp is shown next to a
 * number that was bucketed by `businessDayISO`, the two must be the same calendar:
 * production runs on UTC, so a 00:30 Israel-time event formatted with the plain
 * helper above prints the PREVIOUS day's date under a heading that says today —
 * the exact off-by-one-day class business-day.ts exists to end.
 */
const heTime = new Intl.DateTimeFormat('he-IL', { timeZone: BUSINESS_TIMEZONE, hour: '2-digit', minute: '2-digit' });
const heDateShort = new Intl.DateTimeFormat('he-IL', { timeZone: BUSINESS_TIMEZONE, day: '2-digit', month: '2-digit', year: '2-digit' });
/** UTC on purpose: its input is a business-day KEY ('YYYY-MM-DD'), already a plain
 *  calendar date with no timezone meaning — read at midday so no zone can shift it. */
const heDayLabel = new Intl.DateTimeFormat('he-IL', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** '14:32' in the business timezone. */
export function formatBusinessTime(iso: string): string {
  return heTime.format(new Date(iso));
}

/** '29.07.26' in the business timezone. */
export function formatBusinessDateShort(iso: string): string {
  return heDateShort.format(new Date(iso));
}

/** A business-day key → 'יום שלישי, 29 ביולי 2026'. */
export function formatBusinessDayLabel(dayISO: string): string {
  return heDayLabel.format(new Date(`${dayISO}T12:00:00Z`));
}
