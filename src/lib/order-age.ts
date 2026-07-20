// Order-age chip for the seller's Orders tab. Every order that isn't finished
// (i.e. not 'delivered') shows how long it's been open. An order the seller has
// not yet acted on (still 'pending') ESCALATES by age — calm → amber → red — so
// a backlog of neglected orders is impossible to miss; an order already in
// progress (processing/ready/shipped) just shows its age calmly, no color
// pressure, since the seller is already on it. No blink/pulse — colour alone.
// Pure + isomorphic (no node deps) so the same result renders SSR and inside
// the client card builder — import from both.

export type OrderAgeLevel = 'fresh' | 'aging' | 'overdue';

// Untouched past a day → amber; past three days → red/urgent. Tuned for the
// "ship within 1–2 business days" expectation of a marketplace order.
const AGING_HOURS = 24;
const OVERDUE_HOURS = 72;

/** Age (hours) of an order, floored at 0 so a clock-skewed future date can't go negative. */
export function orderAgeHours(createdAt: string, now = Date.now()): number {
  return Math.max(0, (now - new Date(createdAt).getTime()) / 3_600_000);
}

export function orderAgeLevel(hours: number): OrderAgeLevel {
  if (hours >= OVERDUE_HOURS) return 'overdue';
  if (hours >= AGING_HOURS) return 'aging';
  return 'fresh';
}

// Chip text. An unhandled ('pending') order reads "ממתינה…" (waiting — it needs
// action); an in-progress order reads a neutral "לפני…" (placed N ago). Only
// he/en exist in this app.
function ageLabel(hours: number, lang: 'he' | 'en', unhandled: boolean): string {
  if (hours < 1) {
    if (unhandled) return lang === 'he' ? 'התקבלה זה עתה' : 'Just received';
    return lang === 'he' ? 'לפני רגע' : 'Just now';
  }
  if (hours < 24) {
    const h = Math.round(hours);
    if (unhandled) {
      if (lang === 'he') return h === 1 ? 'ממתינה שעה' : `ממתינה ${h} שעות`;
      return `Waiting ${h}h`;
    }
    if (lang === 'he') return h === 1 ? 'לפני שעה' : `לפני ${h} שעות`;
    return `${h}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (unhandled) {
    if (lang === 'he') return days === 1 ? 'ממתינה יממה' : `ממתינה ${days} ימים`;
    return days === 1 ? 'Waiting 1 day' : `Waiting ${days} days`;
  }
  if (lang === 'he') return days === 1 ? 'לפני יום' : `לפני ${days} ימים`;
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

const CLOCK_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>';
const ALERT_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

const CHIP_CLASSES: Record<OrderAgeLevel, string> = {
  fresh:
    'text-[color:var(--color-muted)] bg-[color:color-mix(in_srgb,var(--color-muted)_12%,transparent)]',
  aging:
    'text-[color:var(--color-warning)] bg-[color:color-mix(in_srgb,var(--color-warning)_15%,transparent)]',
  overdue:
    'text-[color:var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)]',
};

/**
 * A small "how long has this order been open" pill for the order-card header.
 * Shown on every not-yet-delivered order. A 'pending' (unhandled) order
 * escalates by age (calm → amber → red); an in-progress order stays calm/muted
 * regardless of age (the seller is already on it). Returns '' once delivered.
 * `opts.emphasize` makes an overdue pill pulse — used on the admin platform-wide
 * orders view where a neglected order needs to jump out (the seller's own tab
 * keeps it calm, no blink). Text is fixed i18n copy + the order's own age — no
 * user-supplied data — so it is safe to inject via set:html / innerHTML.
 */
export function orderAgeChipHtml(
  createdAt: string,
  shippingStatus: string,
  lang: 'he' | 'en',
  opts: { now?: number; emphasize?: boolean } = {},
): string {
  if (shippingStatus === 'delivered') return '';
  const unhandled = shippingStatus === 'pending';
  const hours = orderAgeHours(createdAt, opts.now ?? Date.now());
  // Only an un-acted order escalates; anything in progress is just informational.
  const level = unhandled ? orderAgeLevel(hours) : 'fresh';
  const text = ageLabel(hours, lang, unhandled);
  const icon = level === 'overdue' ? ALERT_ICON : CLOCK_ICON;
  const pulse = opts.emphasize && level === 'overdue' ? ' animate-pulse motion-reduce:animate-none' : '';
  return `<span class="inline-flex items-center gap-[0.2rem] text-[0.66rem] font-bold px-[0.45rem] py-[0.1rem] rounded-full ${CHIP_CLASSES[level]}${pulse}" title="${text}">${icon}${text}</span>`;
}

/**
 * Card-level emphasis class for a badly-overdue order (a 'pending' order past
 * the overdue threshold) — a red border + faint red fill so the whole row jumps
 * out in a long list. Empty for anything else. Used on the admin platform-wide
 * orders view; `!` overrides the card's own base + hover border/bg utilities.
 */
export function orderAgeCardClass(createdAt: string, shippingStatus: string, now = Date.now()): string {
  if (shippingStatus !== 'pending') return '';
  if (orderAgeLevel(orderAgeHours(createdAt, now)) !== 'overdue') return '';
  return '!border-[color:var(--color-danger)] !bg-[color:color-mix(in_srgb,var(--color-danger)_6%,var(--color-surface))]';
}
