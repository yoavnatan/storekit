import { rows, firstRow, isUuid } from '../db.js';

/**
 * The buyer's invoice, AFTER the decision that the platform does not issue it (owner, 2026-08-13).
 *
 * The platform invoices only revenue that is its own — commission, subscription, ad margin. The sale
 * itself is the seller's, so the tax invoice for it is the seller's to produce and to hand over, in
 * his own name and out of his own tax file. Nothing here creates a document; it records that the
 * seller says he has provided one, and how.
 *
 * ── Why this reuses `invoice_documents` instead of a new table ──
 * `checkout.ts` already plans a `seller_to_buyer` row for every paid order slice, and that row is
 * exactly the statement "this order is owed an invoice" — which under the new model is a to-do list
 * for the SELLER rather than for us. So the backlog already exists, per order, deduplicated by the
 * partial unique index, and the seller's action is the settlement of a row that is already there.
 * A second table would have been a second answer to "does this order have an invoice yet".
 *
 * ── The two ways a seller settles it ──
 *   `seller_upload`   — he issued it in his own system and uploaded the file. The buyer can open it.
 *   `seller_handover` — he gave it with the goods: in the parcel, or by hand at self-pickup. There is
 *                       no file and there must not be a pretend one; the row records the claim and
 *                       who made it, which is all the platform can honestly know.
 *
 * ⚠️ The platform does not and cannot verify that a document was really issued. The obligation is
 * the seller's, and `terms.astro` says so to both sides. What this surface buys is that a buyer who
 * asks has somewhere to look, and a seller who forgot has something to be reminded of.
 */

export type BuyerInvoiceMode = 'upload' | 'handover';

export const BUYER_INVOICE_PROVIDER: Record<BuyerInvoiceMode, string> = {
  upload: 'seller_upload',
  handover: 'seller_handover',
};

export interface BuyerInvoiceState {
  orderId: string;
  /** `pending` until the seller settles it; `issued` once he has. */
  status: 'pending' | 'issued' | 'failed' | 'cancelled';
  mode: BuyerInvoiceMode | null;
  documentUrl: string | null;
  providedAt: string | null;
}

interface StateRow {
  order_id: string;
  status: BuyerInvoiceState['status'];
  provider: string | null;
  document_url: string | null;
  issued_at: Date | string | null;
}

const modeOf = (provider: string | null): BuyerInvoiceMode | null =>
  provider === BUYER_INVOICE_PROVIDER.upload ? 'upload'
  : provider === BUYER_INVOICE_PROVIDER.handover ? 'handover'
  : null;

const iso = (v: Date | string | null): string | null =>
  !v ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

function toState(row: StateRow): BuyerInvoiceState {
  return {
    orderId: row.order_id,
    status: row.status,
    mode: modeOf(row.provider),
    documentUrl: row.document_url,
    providedAt: iso(row.issued_at),
  };
}

/**
 * A file the seller uploaded is only ever OUR storage — and only ever an upload.
 *
 * The dashboard uploads straight to Cloudinary and posts back the resulting URL, so the URL arrives
 * from the client and is therefore a claim, not a fact. Left unchecked it is a stored redirect: the
 * seller — or anyone who can drive that request — names any address, and the platform then shows
 * every buyer of that order a link it vouches for. Same reasoning as `lib/safe-redirect.ts`, one
 * surface over.
 *
 * **The host alone is not enough, and this is the part that is easy to get wrong.** Two things get
 * past `hostname === 'res.cloudinary.com'` and both deliver arbitrary content from a URL that looks
 * like ours:
 *   · **another account.** `res.cloudinary.com/<any-cloud>/…` is a stranger's Cloudinary, so the
 *     first path segment has to be OUR cloud name, not merely present.
 *   · **the `fetch` delivery type.** `…/image/fetch/https://elsewhere/x` makes Cloudinary a proxy
 *     for any remote address — the exact bypass the host check was meant to prevent, spelled with
 *     our own hostname. `cdn.ts` uses `fetch` legitimately for remote product images; an invoice is
 *     never one, so `upload` is the only delivery type accepted here.
 */
/** Read per call, and from both places, rather than captured once at module load: `import.meta.env`
 *  is the build's answer and is undefined under Vitest, so a check pinned to it would be a rule that
 *  passes every test by refusing everything and is never actually exercised. */
const cloudName = (): string | undefined =>
  (import.meta.env?.PUBLIC_CLOUDINARY_CLOUD_NAME as string | undefined)
  ?? process.env.PUBLIC_CLOUDINARY_CLOUD_NAME;

export function isStoredDocumentUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') return false;

  // /<cloud>/<resource_type>/<delivery_type>/… — anything shorter is not a delivery URL at all.
  const [cloud, , delivery] = parsed.pathname.replace(/^\//, '').split('/');
  // No configured cloud means nothing can be proven ours, so nothing is accepted. A deployment
  // missing the variable should refuse uploads, not trust every Cloudinary account there is.
  const ours = cloudName();
  if (!ours || cloud !== ours) return false;
  return delivery === 'upload';
}

/**
 * Record that the seller provided the buyer's invoice for one order.
 *
 * Scoped by `seller_id` in the WHERE, not checked before it: the order id comes from the client and
 * an id is not a permission ([[project_checkout_idempotency_ownership]]). A seller naming another
 * seller's order updates zero rows and gets `null`, which is the same answer as an order that does
 * not exist — nothing distinguishes them to the caller, so nothing is probeable.
 *
 * Re-settling is allowed and deliberate: a seller who ticked "handed over" and later uploads the
 * file should end with the file. `issued_at` is left at the FIRST settlement (`COALESCE`) because it
 * answers "when did this stop being outstanding", which the correction does not change — and it is
 * `clearBuyerInvoiceProvided` that nulls it, because an undo DOES change that answer.
 */
export async function markBuyerInvoiceProvided(
  sellerId: string,
  orderId: string,
  input: { mode: BuyerInvoiceMode; documentUrl?: string | null },
): Promise<BuyerInvoiceState | null> {
  if (!isUuid(sellerId) || !isUuid(orderId)) return null;

  const url = input.mode === 'upload' ? (input.documentUrl ?? '') : '';
  // An upload with nothing to open is not an upload. Refused rather than downgraded to a handover:
  // the seller picked the mode, and silently recording a different one is a claim he did not make.
  if (input.mode === 'upload' && !isStoredDocumentUrl(url)) return null;

  const updated = await firstRow<StateRow>(
    `UPDATE invoice_documents
        SET status = 'issued',
            provider = $3,
            document_url = $4,
            issued_at = COALESCE(issued_at, now())
      WHERE order_id = $1
        AND seller_id = $2
        AND direction = 'seller_to_buyer'
  RETURNING order_id, status, provider, document_url, issued_at`,
    [orderId, sellerId, BUYER_INVOICE_PROVIDER[input.mode], input.mode === 'upload' ? url : null],
  );
  return updated ? toState(updated) : null;
}

/**
 * The state of the buyer's invoice for a page of orders, as a map keyed by order id.
 *
 * One query for the whole page rather than one per card — the orders list renders 20 at a time and
 * a per-card read would be 20 round trips for a strip of text ([[project_sequential_await_latency]]).
 * An order with no row simply is not in the map, which is the honest answer for an order placed
 * before this surface existed.
 */
export async function getBuyerInvoiceStates(
  sellerId: string,
  orderIds: readonly string[],
): Promise<Map<string, BuyerInvoiceState>> {
  const ids = orderIds.filter(isUuid);
  if (!isUuid(sellerId) || ids.length === 0) return new Map();

  const found = await rows<StateRow>(
    `SELECT order_id, status, provider, document_url, issued_at
       FROM invoice_documents
      WHERE seller_id = $1
        AND direction = 'seller_to_buyer'
        AND order_id = ANY($2::uuid[])`,
    [sellerId, ids],
  );
  return new Map(found.map((r) => [r.order_id, toState(r)]));
}

/**
 * What the BUYER is shown for one order slice — a link if there is a file, nothing otherwise.
 *
 * Keyed by order id and store, and it deliberately does not take a seller id: the buyer has no idea
 * which seller id is behind a store, and asking the caller for one would push an ownership decision
 * onto a page that cannot make it. The store slug is the buyer's own view of the same slice.
 */
export async function getBuyerInvoiceForOrder(orderId: string): Promise<BuyerInvoiceState[]> {
  if (!isUuid(orderId)) return [];
  const found = await rows<StateRow>(
    `SELECT order_id, status, provider, document_url, issued_at
       FROM invoice_documents
      WHERE order_id = $1 AND direction = 'seller_to_buyer'`,
    [orderId],
  );
  return found.map(toState);
}

/**
 * Undo a settlement — back to owed, as if the button had never been pressed.
 *
 * **Reversible on purpose, and it is not a money action.** The two buttons sit next to each other,
 * so "צורפה לחבילה" is one slip of the finger away from an upload, and what the row holds is a
 * CLAIM the seller made rather than a document anyone issued: nothing was sent, nothing was charged,
 * and no tax document exists that would need a credit note to cancel. A one-way button on a claim
 * that easy to make wrong is a trap.
 *
 * `issued_at` is cleared rather than kept. It answers "when did this stop being outstanding", and
 * after an undo the honest answer is that it has not — a retained timestamp would make the NEXT
 * settlement report the moment of the mistake.
 *
 * Same seller-scoped WHERE as the settle path, for the same reason: the order id comes from a client.
 */
export async function clearBuyerInvoiceProvided(
  sellerId: string,
  orderId: string,
): Promise<BuyerInvoiceState | null> {
  if (!isUuid(sellerId) || !isUuid(orderId)) return null;
  const updated = await firstRow<StateRow>(
    `UPDATE invoice_documents
        SET status = 'pending', provider = NULL, document_url = NULL, issued_at = NULL
      WHERE order_id = $1
        AND seller_id = $2
        AND direction = 'seller_to_buyer'
  RETURNING order_id, status, provider, document_url, issued_at`,
    [orderId, sellerId],
  );
  return updated ? toState(updated) : null;
}

/**
 * The uploaded invoice URL for each of a set of orders — the buyer's side of the same rows.
 *
 * **The caller must already have proved these orders are the buyer's**, and on the one page that
 * calls it they are: the buyer dashboard renders orders it read for this signed-in buyer and passes
 * back their own ids. This function deliberately takes no buyer id, because there is nothing here it
 * could check one against — `invoice_documents` knows the seller and the order, not the buyer — and
 * a parameter that is accepted but not verified is worse than none: it reads like authorization.
 *
 * Only `upload` rows are returned. A handover has no file and a `pending` row has nothing to show;
 * both are simply absent from the map, so the caller cannot accidentally render an empty link.
 */
export async function getBuyerInvoiceUrls(orderIds: readonly string[]): Promise<Map<string, string>> {
  const ids = orderIds.filter(isUuid);
  if (ids.length === 0) return new Map();
  const found = await rows<{ order_id: string; document_url: string }>(
    `SELECT order_id, document_url
       FROM invoice_documents
      WHERE order_id = ANY($1::uuid[])
        AND direction = 'seller_to_buyer'
        AND provider = $2
        AND document_url IS NOT NULL`,
    [ids, BUYER_INVOICE_PROVIDER.upload],
  );
  return new Map(found.map((r) => [r.order_id, r.document_url]));
}
