// Order-age chip for the seller's Orders tab. Every order that isn't finished
// (i.e. not 'delivered'/'cancelled') shows how long it's been open. Any order
// that still OWES the seller a shipping action — 'pending' (not started),
// 'processing' or 'ready' (started but not yet shipped) — ESCALATES by age,
// calm → amber → red, so nothing falls through the cracks: a fresh order that
// sits unhandled AND an order the seller began but never shipped both light up.
// Once 'shipped' it's out of the seller's hands (waiting on the carrier/buyer),
// so it just shows its age calmly, no colour pressure. Age is measured from
// createdAt throughout — the buyer's clock — so a stalled order reads as late
// regardless of when the seller happened to touch it. Colour + icon on the age
// chip alone signal escalation — no blink/pulse and no card border, on either
// the seller's own Orders tab or the admin platform-wide view (the chip is
// enough; a red card border/fill was tried and read as too loud, dropped).
// Pure + isomorphic (no node deps) so the same result renders SSR and inside
// the client card builder — import from both.

export type OrderAgeLevel = 'fresh' | 'aging' | 'overdue';

// States where the seller still owes a shipping action → these escalate by age.
// 'shipped'/'delivered'/'cancelled' are done from the seller's side.
const OWES_ACTION: readonly string[] = ['pending', 'processing', 'ready'];
// Terminal for the chip — nothing to nudge.
const NO_CHIP: readonly string[] = ['delivered', 'cancelled'];

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

// The three chip tones:
//   unhandled  — a 'pending' order not yet started → "ממתינה…" (waiting for you)
//   stalled    — started ('processing'/'ready') but overdue/aging, not shipped
//                → "טרם נשלחה…" (still not shipped) — the second escalation
//   inProgress — otherwise (started & on-time, or 'shipped') → neutral "לפני…"
// Only he/en exist in this app.
type AgeTone = 'unhandled' | 'stalled' | 'inProgress';

// Bare human duration, no framing verb ("שעה" / "3 ימים" / "3h" / "3 days").
function durationStr(hours: number, lang: 'he' | 'en'): string {
  if (hours < 1) return lang === 'he' ? 'זה עתה' : 'moments';
  if (hours < 24) {
    const h = Math.round(hours);
    if (lang === 'he') return h === 1 ? 'שעה' : `${h} שעות`;
    return `${h}h`;
  }
  const days = Math.floor(hours / 24);
  if (lang === 'he') return days === 1 ? 'יום' : `${days} ימים`;
  return days === 1 ? '1 day' : `${days} days`;
}

function ageLabel(hours: number, lang: 'he' | 'en', tone: AgeTone): string {
  if (tone === 'unhandled') {
    if (hours < 1) return lang === 'he' ? 'התקבלה זה עתה' : 'Just received';
    const dur = durationStr(hours, lang);
    return lang === 'he' ? `ממתינה ${dur}` : `Waiting ${dur}`;
  }
  if (tone === 'stalled') {
    const dur = durationStr(hours, lang);
    return lang === 'he' ? `טרם נשלחה · ${dur}` : `Not shipped · ${dur}`;
  }
  if (hours < 1) return lang === 'he' ? 'לפני רגע' : 'Just now';
  const dur = durationStr(hours, lang);
  return lang === 'he' ? `לפני ${dur}` : `${dur} ago`;
}

const CLOCK_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>';
const ALERT_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

// Text colour only — no background pill. A filled tint read as a second badge
// stacked under the status pill (owner feedback, 2026-07); the colour + icon
// alone carry the escalation, lighter and cleaner in the collapsed card row.
const CHIP_CLASSES: Record<OrderAgeLevel, string> = {
  fresh: 'text-[color:var(--color-muted)]',
  aging: 'text-[color:var(--color-warning)]',
  overdue: 'text-[color:var(--color-danger)]',
};

/**
 * A small "how long has this order been open" pill for the order-card header.
 * Shown on every not-yet-delivered order. A 'pending' (unhandled) order
 * escalates by age (calm → amber → red); an in-progress order stays calm/muted
 * regardless of age (the seller is already on it). Returns '' once delivered.
 * Same calm rendering on both the seller's own Orders tab and the admin
 * platform-wide view — the coloured chip is the only escalation signal (no
 * pulse, no card border). Text is fixed i18n copy + the order's own age — no
 * user-supplied data — so it is safe to inject via set:html / innerHTML.
 */
export function orderAgeChipHtml(
  createdAt: string,
  shippingStatus: string,
  lang: 'he' | 'en',
  opts: { now?: number } = {},
): string {
  if (NO_CHIP.includes(shippingStatus)) return '';
  const owes = OWES_ACTION.includes(shippingStatus);
  const hours = orderAgeHours(createdAt, opts.now ?? Date.now());
  // Only an order that still owes a shipping action escalates; a 'shipped' one
  // is out of the seller's hands, so it stays calm/informational.
  const level = owes ? orderAgeLevel(hours) : 'fresh';
  const tone: AgeTone = shippingStatus === 'pending'
    ? 'unhandled'
    : (owes && level !== 'fresh' ? 'stalled' : 'inProgress');
  const text = ageLabel(hours, lang, tone);
  const icon = level === 'overdue' ? ALERT_ICON : CLOCK_ICON;
  return `<span class="inline-flex items-center gap-[0.2rem] text-[0.66rem] font-semibold whitespace-nowrap ${CHIP_CLASSES[level]}" title="${text}">${icon}${text}</span>`;
}
