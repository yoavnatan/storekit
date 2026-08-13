/**
 * Length ceilings for seller-supplied free text, enforced on the SERVER.
 *
 * **The hole this closes (found 2026-08-12, owner asked the question that found it).**
 * `/api/product` read `name`, `description`, `brand`, `sku` and `sellerNote` straight out of
 * `request.formData()` with no cap of any kind, and `store_products.description` is an unbounded
 * Postgres `text`. A seller — or anyone with a seller session and `curl` — could store a
 * megabyte-scale description, and it would then be rendered on a public product page, carried into
 * the JSON-LD, and written into the Merchant/Meta product feed and the sitemap surfaces built from
 * the same rows. The spam and keyword-stuffing filters were already on that path and are NOT this:
 * they judge what the text SAYS, and had nothing to say about how much of it there is.
 *
 * **Why this is not `BODY_LIMIT`.** `lib/request-body.ts` bounds how many bytes a request may
 * occupy in memory, and its own header states the division explicitly — "field-level caps still
 * belong in the route". It also never applied here: `BODY_LIMIT` guards `readJsonBody`, and the
 * product routes post `multipart/form-data`, so nothing was bounding them at all.
 *
 * **Why a vocabulary rather than a number per call site.** Same argument `BODY_LIMIT` makes: a
 * limit chosen separately at each of a dozen routes is a dozen chances to pick one that is too
 * tight for a real seller, and no way to see the set. Every value below is far above what a
 * genuine listing needs — the longest description in the platform's own showcase catalog is ~360
 * characters, so `description` at 5,000 leaves a seller who genuinely writes a lot completely
 * alone. The point is to bound abuse, never to edit anyone's copy (memory
 * `feedback_seller_form_burden` — a limit a real seller can feel is an entry barrier).
 *
 * Client-side `maxlength` stays where it is, but it is a courtesy and not a control: it is absent
 * from the two biggest fields today, and it is one devtools edit away from gone in any case.
 */

/** Characters, not bytes — Hebrew is multi-byte in UTF-8 and a byte cap would silently give a
 *  Hebrew seller roughly half the room an English one gets for the same visible text. */
export const FIELD_LIMIT = {
  /** A product or store title. Long enough for a descriptive listing, short enough that it cannot
   *  become a paragraph of keywords wearing a title's markup. */
  name: 200,
  /** The long one. A full product description with paragraphs. */
  description: 5_000,
  /** Brand. The dashboard's own input says 70; this leaves headroom above it. */
  brand: 100,
  /** One tag. The COUNT of tags is capped separately where they are parsed. */
  tag: 50,
  sku: 64,
  /** Seller's private note on a product/order — never public, so it is capped for storage only.
   *  Matches the textarea's own `maxlength`. */
  note: 2_000,
  /** A store's one-line tagline. */
  tagline: 200,
  /** A category name. The dashboard input says 40. */
  categoryName: 100,
} as const;

export type FieldLimitKey = keyof typeof FIELD_LIMIT;

/** A field that was too long: which one, and by how much, so the message can say something true. */
export interface FieldLimitViolation {
  /** The seller-facing label, already localised by the caller. */
  label: string;
  limit: number;
  actual: number;
}

/**
 * The first violation in `fields`, or `null`.
 *
 * First rather than all, deliberately: these routes answer with a single `error` string, and a
 * seller who pasted one enormous block wants to be told about that block, not handed a list.
 *
 * Note it does not TRUNCATE. Silently storing a shortened version of what someone wrote is the
 * worse failure — they would discover it later on the live page, with no idea what removed it.
 */
export function findFieldOverLimit(
  fields: readonly { value: string | null | undefined; limit: number; label: string }[],
): FieldLimitViolation | null {
  for (const f of fields) {
    // `[...str]` counts code points, so an emoji or a surrogate pair is one character rather than
    // two — `.length` would let a caller quietly get half the allowance for the same visible text.
    const actual = f.value ? [...f.value].length : 0;
    if (actual > f.limit) return { label: f.label, limit: f.limit, actual };
  }
  return null;
}

/**
 * Every capped field of a product listing, in one call.
 *
 * It lives here rather than in the route because `/api/product` needs it TWICE — once on create and
 * once on the merged record an edit produces — and two copies of a field list is exactly how one of
 * them ends up missing the field that was added last. Any future writer of product text (a bulk
 * import, an admin edit) calls this instead of assembling its own list.
 *
 * `tags` is capped per tag, not in total: the count is bounded where tags are parsed, and a seller
 * with many short tags is normal while a single essay-length tag is not.
 */
export function productFieldsOverLimit(p: {
  name?: string; description?: string; brand?: string;
  tags?: readonly string[]; sku?: string; sellerNote?: string;
}): FieldLimitViolation | null {
  return findFieldOverLimit([
    { value: p.name, limit: FIELD_LIMIT.name, label: 'שם המוצר' },
    { value: p.description, limit: FIELD_LIMIT.description, label: 'תיאור' },
    { value: p.brand, limit: FIELD_LIMIT.brand, label: 'מותג' },
    { value: p.sku, limit: FIELD_LIMIT.sku, label: 'מק״ט' },
    { value: p.sellerNote, limit: FIELD_LIMIT.note, label: 'הערה פנימית' },
    ...(p.tags ?? []).map((t) => ({ value: t, limit: FIELD_LIMIT.tag, label: 'תגית' })),
  ]);
}

/**
 * The store's own public text. Same reasoning as `productFieldsOverLimit`: three writers touch these
 * three fields — `/api/store.ts`, and the two no-JS fallbacks in `seller/dashboard.astro` (create a
 * store, save its settings) — and a field list written out three times is a field list that will
 * disagree.
 */
export function storeTextOverLimit(s: {
  name?: string; tagline?: string; description?: string;
}): FieldLimitViolation | null {
  return findFieldOverLimit([
    { value: s.name, limit: FIELD_LIMIT.name, label: 'שם החנות' },
    { value: s.tagline, limit: FIELD_LIMIT.tagline, label: 'משפט תיאור' },
    { value: s.description, limit: FIELD_LIMIT.description, label: 'תיאור החנות' },
  ]);
}

/** Hebrew, and it names the number twice on purpose — a seller staring at a rejected form needs to
 *  know both the ceiling and how far over it they are, or the only way forward is to guess and
 *  resubmit. Same shape and same file-local-string idiom as `spamRejectionMessage`. */
export function fieldLimitRejectionMessage(v: FieldLimitViolation): string {
  return `השדה "${v.label}" ארוך מדי — ${v.actual.toLocaleString('he-IL')} תווים, `
    + `והמקסימום הוא ${v.limit.toLocaleString('he-IL')}. קצרו אותו כדי להמשיך.`;
}
