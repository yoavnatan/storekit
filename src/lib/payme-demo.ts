/**
 * The clearing company, when there is no clearing company.
 *
 * `payment-payme.ts` puts every single call to PayMe through one function — `sendPayme`, one POST
 * or PATCH, one JSON body, one status check. That is the seam this file plugs into, and it is why
 * a demonstration of the whole money side costs one branch rather than a parallel implementation:
 * merchant creation, approval, the buyer token, split capture, refunds, subscriptions, price
 * changes and cancellation all sit ABOVE that function and cannot tell the difference. None of
 * them is modified, mocked or bypassed. They make the same calls in the same order and read the
 * same fields out of the answers; the answers simply come from here.
 *
 * **This is not a mock in the testing sense and must not become one.** A mock exists to make an
 * assertion pass. This exists to make a screen true. Every field below is shaped the way PayMe's
 * own answers were MEASURED to be shaped (`docs/payme-sandbox-notes.md`, and the parsing code in
 * `payment-payme.ts` right beside each call) — including the awkward parts, like `seller_approved`
 * arriving as a JSON boolean in one place and the string `'1'` in another, and `sub_status` being
 * their six-value enum rather than the two-value one their Generate page prints. Answering in a
 * tidier shape than the real thing would mean the demo exercises a code path production never
 * takes, which is the one failure mode a demonstration must not have.
 *
 * ── Where state lives, and why almost none of it lives here ──────────────────
 *
 * A stand-in gateway needs memory: a merchant created must be findable, a cancelled subscription
 * must stay cancelled. The obvious answer — a Map in this module — is wrong for a host that sleeps
 * and restarts, which is exactly what the demo runs on. Losing that Map would make PayMe forget
 * every merchant on the platform, and `getSellerStatus` answering `null` means "we do not know this
 * business", which strands a seller mid-flow with no way back.
 *
 * So state is read from the records the application already keeps:
 *
 *   · **merchant approval** — from `seller_merchant_accounts.created_at`. A business is approved
 *     once `DEMO_APPROVAL_SECONDS` have passed since we opened its account. Durable across
 *     restarts, needs no table, and produces the genuine pending→approved transition rather than
 *     hiding the waiting screens (`demo-mode.ts` argues the number).
 *   · **subscriptions** — from `seller_subscriptions`, mirrored back. This looks circular and is
 *     not: our row is written from the answers to `generate-subscription` and `cancel-subscription`,
 *     so mirroring it makes `refreshSubscription` a stable no-op instead of a source of drift. In
 *     production that call is the authority precisely BECAUSE PayMe hold state we do not; with no
 *     PayMe there is no second opinion to have.
 *   · **the invoicing add-on** — a keyed row in `app_settings`, because it is the one genuinely
 *     mutable thing with nowhere else to be. Two fields in a jsonb value is not a table.
 *
 * The ids carry their own creation time (`demo-mrc-<base36 ms>-<random>`), so even a database that
 * has been reset answers coherently rather than claiming an unknown business.
 *
 * ── What is deliberately EMPTY ───────────────────────────────────────────────
 *
 * `get-transactions`, `get-withdrawals` and `get-future-withdrawals` return no rows. They are
 * PayMe's own ledger — what a charge really cost and what was really transferred to a bank — and
 * inventing figures for them would put numbers on the transfers strip that disagree with the
 * orders, the reports and the balance on the very same dashboard. An empty strip reads as "no
 * transfers yet", which is true here and costs the demonstration a corner; contradictory money
 * numbers would cost it its credibility. The portfolio seeder fills this side from real orders.
 *
 * Nothing in this file is reachable unless `DEMO_MODE=1` — `paymeCredentials()` only hands out the
 * sentinel base URL in demo mode, and `sendPayme` only routes here when it sees that URL.
 */
import crypto from 'node:crypto';
import { firstRow, query, rows } from './db.js';
import { DEMO_APPROVAL_SECONDS } from './demo-mode.js';

/**
 * The base URL that means "answer locally".
 *
 * A URL rather than a boolean on the credentials object, because `isSandbox()` and every log line
 * in `payment-payme.ts` already read the base URL to say which environment a call is about to hit.
 * A scheme no fetch can resolve is the honest spelling: if this ever escapes the branch below and
 * reaches the network layer, it fails loudly instead of quietly reaching something real.
 */
export const DEMO_PAYME_BASE_URL = 'demo://payme.local/api/';

/** The client key the demo's credentials carry. Not a secret and not accepted anywhere — it exists
 *  so that a body logged during development is recognisable at a glance. */
export const DEMO_PAYME_CLIENT_KEY = 'demo-client-key';

/** Our own marketplace merchant, for the subscription side (`PaymeCredentials.ownMerchantId`). */
export const DEMO_PAYME_OWN_MERCHANT = 'demo-mrc-platform';

const VAS_SETTINGS_KEY = 'demo_payme_vas';

/** PayMe's `sub_status`, repeated rather than imported: `payment-payme.ts` imports THIS module, and
 *  a cycle back the other way is a hazard for the sake of two integers. Kept in step by
 *  `tests/payme-demo.test.ts`, which asserts these equal the exported enum. */
const SUB_STATUS_ACTIVE = 2;
const SUB_STATUS_CANCELED = 5;

const rand = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

/** An id that carries the moment it was minted, so approval can be timed with no stored row. */
function mintMerchantId(): string {
  return `demo-mrc-${Date.now().toString(36)}-${rand(4)}`;
}

/** The creation time inside an id minted above, or null for anything else (including the ids of a
 *  database seeded rather than registered). */
function mintedAt(merchantId: string): number | null {
  const part = /^demo-mrc-([0-9a-z]+)-/.exec(merchantId)?.[1];
  if (!part) return null;
  const ms = parseInt(part, 36);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Has the stand-in clearing company finished examining this business?
 *
 * The account row is asked first because it is the durable answer, and it is also the one a seeder
 * can set: a showcase store must be approved from the moment it exists, and back-dating its
 * `created_at` is how the seeder says so. The id's own timestamp is the fallback for a merchant
 * whose row has not been written yet — `create-seller` returns before `ensureMerchantAccount`
 * inserts, and a status asked in that window must not read as "unknown business".
 *
 * Anything with neither is approved. That is the forgiving direction and the correct one here: an
 * id we cannot date belongs to a fixture, and a demonstration whose fixtures are stuck in review
 * shows nothing at all.
 */
async function approvedYet(merchantId: string): Promise<boolean> {
  const row = await firstRow<{ created_at: Date | string }>(
    'SELECT created_at FROM seller_merchant_accounts WHERE provider_ref = $1',
    [merchantId],
  );
  const createdMs = row
    ? new Date(row.created_at instanceof Date ? row.created_at : String(row.created_at)).getTime()
    : mintedAt(merchantId);
  if (createdMs === null || !Number.isFinite(createdMs)) return true;
  return Date.now() - createdMs >= DEMO_APPROVAL_SECONDS * 1000;
}

async function vasState(): Promise<Record<string, boolean>> {
  const row = await firstRow<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [VAS_SETTINGS_KEY]);
  const value = typeof row?.value === 'string' ? safeParse(row.value) : row?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, boolean>) : {};
}

async function setVas(merchantId: string, active: boolean): Promise<void> {
  const next = { ...(await vasState()), [merchantId]: active };
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [VAS_SETTINGS_KEY, JSON.stringify(next)],
  );
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** PayMe's `YYYY-MM-DD HH:MM:SS`, in their format rather than ISO — the callers pass these strings
 *  straight through to a screen, so the demo must not hand them a shape production never produces. */
function paymeDate(at: Date): string {
  return at.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Answer one PayMe call locally.
 *
 * `status_code: 0` is their success, and the caller checks exactly that — never the HTTP status,
 * which PayMe set inconsistently. A refusal here would be `status_code` non-zero plus
 * `status_error_details`, and there is deliberately no path that produces one: a demonstration
 * whose clearing company randomly declines is a demonstration of a bug report.
 */
export async function answerDemoPayme(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ok = { status_code: 0 };
  const merchantId = String(body.seller_payme_id ?? '');

  switch (endpoint) {
    case 'create-seller': {
      const id = mintMerchantId();
      return {
        ...ok,
        seller_payme_id: id,
        // The per-seller callback signing secret. Real in the sense that matters — the callback
        // signature is computed from it, so a demo callback verifies exactly as production would.
        seller_payme_secret: rand(16),
        // Hosted Fields key, in the object shape their current reference documents. `is_active`
        // true, because `readPublicKey` refuses an inactive one and a seller with no key can never
        // draw a card field again.
        seller_public_key: { uuid: `demo-pk-${rand(6)}`, is_active: true },
        seller_dashboard_signup_link: `https://demo.invalid/kyc/${id}`,
        seller_approved: false,
      };
    }

    case 'get-sellers': {
      const approved = await approvedYet(merchantId);
      return {
        ...ok,
        // An ARRAY that the caller filters by id — `get-sales` was measured ignoring its own
        // filter, so `payment-payme.ts` matches rather than taking `items[0]`. Answering with a
        // bare object would skip that code entirely.
        items: [{
          seller_payme_id: merchantId,
          seller_approved: approved,
          seller_active: approved,
        }],
      };
    }

    case 'capture-buyer-token':
      // One token, permanent, chargeable under any merchant — which is the whole mechanism behind
      // one card entry and N stores. Nothing about a card is received here or stored anywhere.
      return { ...ok, buyer_key: `demo-buyer-${rand(10)}` };

    case 'generate-sale': {
      const price = Number(body.sale_price ?? 0);
      const feePercent = Number(body.market_fee ?? 0);
      const feeFixedShekels = Number(body.market_fee_fixed ?? 0);
      return {
        ...ok,
        payme_sale_id: `demo-sale-${rand(10)}`,
        // `completed` is the only status `saleIsPaid` accepts, and the money in this demo moves
        // exactly as far as the record of it.
        sale_status: 'completed',
        // THEIR arithmetic in production, so it is arithmetic here too rather than a copy of the
        // caller's own figure: percentage of the sale plus the fixed part, back in agorot.
        sale_market_fee_total: Math.round((price * feePercent) / 100 + feeFixedShekels * 100),
      };
    }

    case 'refund-sale':
      return {
        ...ok,
        payme_sale_id: String(body.payme_sale_id ?? ''),
        sale_status: 'refunded',
      };

    case 'get-vas-seller': {
      const active = (await vasState())[merchantId] ?? false;
      return {
        ...ok,
        items: [{
          vas_guid: `demo-vas-invoice-${merchantId}`,
          // `InvoicingService` — one of the two names `seller-invoicing.ts` matches. Their sandbox
          // answers with the name rather than the number, so the demo does too.
          vas_type: 'InvoicingService',
          vas_description: 'הפקת חשבוניות',
          vas_is_active: active,
          vas_price_periodic_fixed: 2900,
          vas_price_usage_fixed: 50,
          vas_period: 1,
        }],
      };
    }

    case 'vas-enable':
      await setVas(String(body.seller_payme_id ?? ''), true);
      return ok;

    case 'vas-disable':
      await setVas(String(body.seller_payme_id ?? ''), false);
      return ok;

    // PayMe's own ledger. Empty on purpose — see the module header.
    case 'get-transactions':
    case 'get-future-withdrawals':
    case 'get-withdrawals':
      return { ...ok, items: [] };

    case 'generate-subscription': {
      const next = new Date();
      next.setMonth(next.getMonth() + 1);
      return {
        ...ok,
        sub_payme_id: `demo-sub-${rand(10)}`,
        // ACTIVE immediately, and no `sub_url`. In production a subscription with no buyer token
        // comes back `initial` with a link to PayMe's own payment page — which does not exist
        // here, so sending a seller to it would be the one dead end in the whole flow. The card
        // panel he just saw said the form is disabled in the demo; this is that sentence being
        // true rather than a second story about the same click.
        sub_status: SUB_STATUS_ACTIVE,
        sub_next_date: paymeDate(next),
      };
    }

    case 'cancel-subscription':
    case 'set-price':
      // Both write nothing here: the application updates its own row from the same call, and
      // `get-subscriptions` mirrors that row back.
      return ok;

    case 'get-subscriptions': {
      // Every subscription we hold a provider reference for. The caller finds its own by id — the
      // same defence against an endpoint that ignores its filter, exercised here too.
      const subs = await rows<{ provider_ref: string; status: number; next_charge: string | null; canceled_at: Date | null }>(
        `SELECT provider_ref, status, next_charge, canceled_at
           FROM seller_subscriptions
          WHERE provider_ref IS NOT NULL`,
      );
      return {
        ...ok,
        items: subs.map((s) => ({
          sub_payme_id: s.provider_ref,
          sub_status: s.canceled_at ? SUB_STATUS_CANCELED : (s.status || SUB_STATUS_ACTIVE),
          ...(s.next_charge ? { sub_next_date: s.next_charge } : {}),
        })),
      };
    }

    default:
      // A named refusal rather than a bland success. An endpoint reaching here is a call this file
      // has not been taught, and answering `{status_code: 0}` with no fields would surface as
      // "succeeded without a payme_sale_id" three frames away from the cause.
      return {
        status_code: 1,
        status_error_code: -1,
        status_error_details: `demo clearing has no answer for "${endpoint}"`,
      };
  }
}
