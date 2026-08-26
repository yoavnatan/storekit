/**
 * Why a seller cancelled — the vocabulary, and nothing else.
 *
 * ── Why it is a module and not a list in the component ──
 * Three surfaces need the same five values: the dialog that offers them, the route that stores one,
 * and (session ד׳) the admin screen that counts them. A list written in the markup and a check
 * written in the route are two definitions of the same set, and the failure mode is silent — a
 * reason the dialog offers and the route drops is a cancellation recorded as "he did not say".
 *
 * ── The set is deliberately short, and one of them is "other" ──
 * Five options fit on a card without becoming a form, and the fifth exists because a fixed list
 * cannot anticipate the answer that matters. The free text beside it is where the real reason
 * usually is — `cancel_note`, read by a person, never parsed.
 *
 * ── Not required, ever ──
 * `parseCancelReason` answers `null` for anything it does not recognise, INCLUDING an empty string,
 * and the route stores that as "he did not say". Refusing to cancel a subscription until a reason
 * is chosen is the retention dark pattern this whole panel was built not to be.
 *
 * The words themselves live in `translations.ts` under `subCancelReason<Id>`, like every other
 * string; this file holds the ids, which are what the database stores and what a count groups by.
 */

export const CANCEL_REASONS = ['expensive', 'no-sales', 'too-complex', 'moving', 'other'] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

/** The translation key for a reason's label. A function rather than a second map, so a reason added
 *  above cannot be given an id here and forgotten in the copy. */
export function cancelReasonKey(reason: CancelReason): string {
  // `expensive` → `subCancelReasonExpensive`. The transformation is spelled out rather than stored
  // because it is the only thing that keeps the two lists from needing to be maintained in step.
  const camel = reason.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return `subCancelReason${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

/** One of the five, or `null` for anything else — an unknown id, an empty field, a tampered body.
 *  Narrowed and never defaulted: recording a reason nobody chose would put a made-up answer into
 *  the one table that exists to say why people leave. */
export function parseCancelReason(value: unknown): CancelReason | null {
  return typeof value === 'string' && (CANCEL_REASONS as readonly string[]).includes(value)
    ? (value as CancelReason)
    : null;
}

/** How much free text is kept. Long enough for a real paragraph, short enough that the column is
 *  not an upload target; the route caps it rather than refusing, because a seller who typed too
 *  much should still have his subscription cancelled. */
export const CANCEL_NOTE_MAX = 600;

export function normalizeCancelNote(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, CANCEL_NOTE_MAX);
  return text || null;
}
