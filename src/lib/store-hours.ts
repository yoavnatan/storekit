import { STORE_WEEKDAYS, type StoreDayHours, type StoreHours, type StoreWeekday } from './stores.js';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Sensible starting point for a new store: Israeli work week (Sun–Thu full day, Fri short, Sat closed). */
export const DEFAULT_STORE_HOURS: StoreHours = {
  sun: { closed: false, open: '09:00', close: '18:00' },
  mon: { closed: false, open: '09:00', close: '18:00' },
  tue: { closed: false, open: '09:00', close: '18:00' },
  wed: { closed: false, open: '09:00', close: '18:00' },
  thu: { closed: false, open: '09:00', close: '18:00' },
  fri: { closed: false, open: '09:00', close: '14:00' },
  sat: { closed: true, open: '09:00', close: '18:00' },
};

function sameDayHours(a: StoreDayHours, b: StoreDayHours): boolean {
  if (a.closed && b.closed) return true;
  return a.closed === b.closed && a.open === b.open && a.close === b.close;
}

interface StoreHoursGroup { startDay: StoreWeekday; endDay: StoreWeekday; hours: StoreDayHours }

/** Groups consecutive weekdays (in STORE_WEEKDAYS order) that share identical hours. */
function groupConsecutiveDays(hours: StoreHours): StoreHoursGroup[] {
  const groups: StoreHoursGroup[] = [];
  let i = 0;
  while (i < STORE_WEEKDAYS.length) {
    const startDay = STORE_WEEKDAYS[i]!;
    const dayHours = hours[startDay];
    let j = i;
    while (j + 1 < STORE_WEEKDAYS.length && sameDayHours(hours[STORE_WEEKDAYS[j + 1]!], dayHours)) j++;
    groups.push({ startDay, endDay: STORE_WEEKDAYS[j]!, hours: dayHours });
    i = j + 1;
  }
  return groups;
}

/** Builds a StoreHours object from dashboard settings-form fields named hours_<day>_closed/open/close. */
export function parseStoreHoursForm(form: FormData): StoreHours {
  const hours = {} as StoreHours;
  for (const day of STORE_WEEKDAYS) {
    const open = String(form.get(`hours_${day}_open`) || '09:00');
    const close = String(form.get(`hours_${day}_close`) || '18:00');
    hours[day] = {
      closed: form.get(`hours_${day}_closed`) === 'on',
      open: TIME_RE.test(open) ? open : '09:00',
      close: TIME_RE.test(close) ? close : '18:00',
    };
  }
  return hours;
}

/** A single displayable hours row split into its day-range label and its time (or "closed")
 *  value, so the UI can align the two to opposite edges of the box instead of running them
 *  together as one string. */
export interface StoreHoursRow { label: string; value: string }

/** Groups consecutive weekdays that share the same hours into readable rows, each split into
 *  a day-range label (e.g. "א׳–ה׳") and its value (e.g. "09:00–18:00" or the closed label). */
export function formatStoreHours(hours: StoreHours, dayLabels: Record<StoreWeekday, string>, closedLabel: string): StoreHoursRow[] {
  return groupConsecutiveDays(hours).map(({ startDay, endDay, hours: dayHours }) => {
    const label = startDay === endDay ? dayLabels[startDay] : `${dayLabels[startDay]}–${dayLabels[endDay]}`;
    return { label, value: dayHours.closed ? closedLabel : `${dayHours.open}–${dayHours.close}` };
  });
}

const SCHEMA_DAY_CODE: Record<StoreWeekday, string> = {
  sun: 'Su', mon: 'Mo', tue: 'Tu', wed: 'We', thu: 'Th', fri: 'Fr', sat: 'Sa',
};

/** schema.org Store.openingHours format, e.g. ["Su-Th 09:00-18:00", "Fr 09:00-14:00"] — closed days are omitted. */
export function formatStoreHoursSchema(hours: StoreHours): string[] {
  return groupConsecutiveDays(hours)
    .filter((g) => !g.hours.closed)
    .map(({ startDay, endDay, hours: dayHours }) => {
      const code = startDay === endDay ? SCHEMA_DAY_CODE[startDay] : `${SCHEMA_DAY_CODE[startDay]}-${SCHEMA_DAY_CODE[endDay]}`;
      return `${code} ${dayHours.open}-${dayHours.close}`;
    });
}

/** A Google Maps search link for a free-text address — no API key, no seller-entered URL needed. */
export function googleMapsSearchUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}
