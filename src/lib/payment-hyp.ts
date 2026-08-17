/**
 * Hyp Pay (יעד שריג) — the transport layer for the first real Israeli gateway.
 *
 * **Why this file is NOT a `PaymentProvider` implementation, and must not be made into one
 * without changing `checkout.ts` first.** `lib/payment.ts` models `authorize()` as a blocking
 * server-side call: hand it an amount, get a held transaction back, all inside one POST. Hyp's
 * J5 authorization does not work that way and neither does any other Israeli gateway that keeps
 * us out of PCI scope — the BUYER authorizes, on Hyp's own hosted page, and our server learns the
 * outcome from the redirect that brings them back. So a real Hyp checkout is two requests with a
 * human in between, and the current flow (authorize → write orders → capture, one handler) has
 * nowhere to put that human. Wiring this in is therefore a checkout restructure, not a one-line
 * provider swap, and the header of `payment.ts` promising "a one-line provider swap HERE" was
 * written before anyone had read a hosted-page gateway's docs. It is wrong for every provider we
 * would actually pick, and this comment is the correction.
 *
 * What this module does instead: it owns the four Hyp operations end to end, pure where it can be
 * and HTTP where it must, so that the restructure — whenever it happens — is only about WHERE
 * these get called, never about how Hyp works.
 *
 * ── The flow, from Hyp's docs (developers.hyp.co.il, read 2026-08-17) ──
 *   1. `signPaymentPageRequest` → `action=APISign&What=SIGN&J5=True` returns a signed query string.
 *      Send the buyer to `<BASE>?<that string>`.
 *   2. The buyer pays. Hyp redirects back with `CCode=700` (J5 approved) plus `Id`, `ACode`,
 *      `UserId` and `UID`. **700, not 0** — an ordinary charge answers 0 and a J5 answers 700, so
 *      code that only knows 0 reads a perfectly good authorization as a failure.
 *   3. `verifyRedirect` → `What=VERIFY`, echoing every redirect parameter back to Hyp. This is
 *      NOT optional: the redirect arrives as a query string in the buyer's own browser, so
 *      without it "paid" is a value the buyer can type. Same class as
 *      `checkout-idempotency.ts` — an id that arrives from outside proves nothing on its own.
 *   4. `fetchCardToken` → the token that lets us capture without ever holding card data.
 *   5. `captureAuthorization` → `action=soft`, at the authorized amount **or less**.
 *   6. `cancelTransaction` → releases an authorization we will never capture. Only until 22:00
 *      Israel time on the same business day, after which it is a refund and not a cancellation —
 *      which is Hyp's own transmission window, not a rule we can shorten by trying harder.
 *
 * ── Two things the checkout restructure MUST carry, found reviewing this file rather than by
 *    writing it, and recorded here because the code that will get them wrong does not exist yet ──
 *
 * **1. The redirect proves a payment happened. It does not prove WHOSE.** It arrives as a query
 * string in the buyer's own browser, carrying our `Order` reference back to us, and a reference
 * that travels through a client is an identifier and never a permission — the exact rule
 * `checkout-idempotency.ts#checkoutOwner` exists for, after an id in a request was once enough to
 * replay somebody else's checkout. `verifyRedirect` answers "did Hyp really authorize this", which
 * is a different question from "is this the buyer whose cart this is". The return route needs
 * both: Hyp's VERIFY *and* its own check that the session presenting the reference is the session
 * that started it.
 *
 * **2. A capture carries no idempotency key, and Hyp document none.** Everywhere else in this
 * codebase a money-moving call is de-duplicated at the provider as well as by our own ledger
 * (`payment.ts`'s `idempotencyKey` is passed through for exactly that). Hyp's `action=soft` has no
 * such parameter: the only correlator is `Order`, which is ours, and what Hyp do with a second
 * capture of the same authorization is UNVERIFIED — it was not worth spending the demo terminal's
 * shared state to find out, and it is a question for them. Until it is answered, the caller must
 * treat "capture" as not safely retryable and decide from its own record whether one already
 * succeeded. Do not assume the gateway will refuse the second one.
 *
 * ── The unit trap, and it is the expensive one ──
 * Hyp mixes units inside a SINGLE request. `Amount` is in shekels (`15`), while
 * `inputObj.originalAmount` on the very same capture is in agorot (`1500`). Get it backwards and
 * the capture is off by a factor of 100 in whichever direction hurts. Everything here therefore
 * takes AGOROT — the unit the rest of this codebase counts money in — and converts at the edge,
 * once, in `shekels()`. Nothing above this file should ever pass Hyp a shekel figure.
 */
import { agorotToDecimalString } from './money';
import { outboundFetch } from './outbound-fetch';
import { serverEnv } from './runtime-env';

/** Hyp answers every one of these calls with a query string, never JSON. */
export type HypResponse = Record<string, string>;

export interface HypCredentials {
  /** Terminal number. A TEST terminal always starts `00100` — Hyp's own rule, and the only
   *  machine-readable way to tell a sandbox charge from a live one. See `isTestTerminal`. */
  masof: string;
  key: string;
  passp: string;
  baseUrl: string;
}

/** J5 authorization approved and the funds are held. NOT 0 — see the header. */
export const HYP_AUTHORIZED = '700';
/** Everything else — capture, token, cancel, verify — answers 0 on success. */
export const HYP_OK = '0';
/** A cancellation that arrived after transmission. The money is real; refund instead. */
export const HYP_NOT_CANCELLABLE = '920';

export function hypCredentials(): HypCredentials | null {
  const masof = serverEnv('HYP_MASOF');
  const key = serverEnv('HYP_KEY');
  const passp = serverEnv('HYP_PASSP');
  if (!masof || !key || !passp) return null;
  return { masof, key, passp, baseUrl: serverEnv('HYP_BASE_URL') || 'https://pay.hyp.co.il/p/' };
}

/**
 * The public demo terminal — Hyp publish it, anyone may use it, and every developer testing
 * against Hyp shares it. A deploy pointed here takes no real money and gives no real card the
 * chance to be charged, which is exactly why it must never survive into production unnoticed.
 *
 * **This is a fact, not an inference, and that distinction is the point.** Hyp's
 * `testing-environments.md` states that test terminals "always start with `00100`", so the
 * obvious helper here would be a prefix check. It would be WRONG: their own documented test
 * terminals are `0010345518` (`00103…`) and `0010131918` (`00101…`), neither of which matches
 * their stated rule, and their documentation assistant, asked directly on 2026-08-17, insisted
 * both "start with 00100" — so the contradiction cannot be resolved from their side either.
 * A safety check that is confidently wrong is worse than none, so there is no prefix check here:
 * which environment we are in comes from which terminal we deliberately configured.
 */
export const HYP_PUBLIC_DEMO_MASOF = '0010131918';

export function isPublicDemoTerminal(masof: string): boolean {
  return masof === HYP_PUBLIC_DEMO_MASOF;
}

/** Agorot → the shekel string Hyp's `Amount` expects. Deliberately `money.ts`'s function and not a
 *  local one: the conversion is a money rule, so it has one owner and the next gateway inherits it
 *  rather than re-deriving it (`agorotToDecimalString`'s header argues why neither `fromAgorot` nor
 *  `formatAgorot` can do this job). */
export const shekels = agorotToDecimalString;

/** Hyp returns `a=1&b=2`. Parsed with URLSearchParams so percent-encoding and `+` are handled the
 *  same way Hyp encoded them, rather than by splitting on '&' and hoping. */
export function parseHypResponse(body: string): HypResponse {
  const out: HypResponse = {};
  for (const [k, v] of new URLSearchParams(body.trim())) out[k] = v;
  return out;
}

/** Credentials travel in the query string (Hyp's design, not ours), so anything that could reach a
 *  log or an error message goes through here first. `authentication-security.md` asks for exactly
 *  this, and an unmasked URL in an error is how a secret ends up in a bug report. */
export function maskCredentials(url: string): string {
  return url.replace(/([?&](?:KEY|PassP|password)=)[^&]*/gi, '$1***');
}

/**
 * `Tokef` → the `Tmonth`/`Tyear` a capture wants. **`Tokef` is YYMM**: Hyp's own worked example
 * returns `Tokef=3105` and captures it as `Tmonth=05&Tyear=31`.
 *
 * Split it the intuitive way round and Hyp answers `CCode=416` ("expiration date is not in a valid
 * format") — which is a good failure, because it is loud. The bad version of this bug is the one
 * where a swapped month and year both parse: `Tokef=1212` reverses to itself, and a card expiring
 * `0524` would read as May 2024 either way round for exactly one month of the year. This function
 * exists so the direction is decided once, with the citation next to it, rather than re-guessed at
 * a call site. Found by running the live proof, not by reading — the docs state the fields but
 * never state the order.
 */
export function splitTokef(tokef: string): { month: string; year: string } {
  return { year: tokef.slice(0, 2), month: tokef.slice(2, 4) };
}

function buildUrl(base: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return `${base}${base.includes('?') ? '&' : '?'}${qs}`;
}

async function callHyp(url: string): Promise<HypResponse> {
  const res = await outboundFetch(url, { timeoutMs: 20_000 });
  if (!res.ok) throw new Error(`hyp: HTTP ${res.status} for ${maskCredentials(url)}`);
  return parseHypResponse(await res.text());
}

export interface PaymentPageRequest {
  amountAgorot: number;
  /** Our checkout reference. Comes back on the redirect as `Order`, which is how we find the
   *  checkout again once the buyer returns from a page we do not control. */
  orderRef: string;
  buyerName?: string;
  buyerEmail?: string;
  description: string;
  lang?: 'HEB' | 'ENG';
}

/**
 * Step 1 — ask Hyp to sign a J5 payment-page request, and return the URL to send the buyer to.
 *
 * `Sign=True` is what makes step 3 possible at all: without it the redirect carries no signature
 * and there is nothing to verify, so it is set here rather than left to a caller to remember.
 * `MoreData=True` is what makes step 5 possible — it is the flag that adds `UID` and `UserId` to
 * the redirect, and a capture cannot be built without them.
 */
export async function signPaymentPageRequest(
  req: PaymentPageRequest,
  creds: HypCredentials,
): Promise<{ url: string; signed: HypResponse }> {
  const signUrl = buildUrl(creds.baseUrl, {
    action: 'APISign', What: 'SIGN',
    KEY: creds.key, PassP: creds.passp, Masof: creds.masof,
    Amount: shekels(req.amountAgorot),
    Coin: '1',                       // ILS. The platform is ILS-only (AI_INSTRUCTIONS, hard constraints).
    J5: 'True', MoreData: 'True', Sign: 'True',
    UTF8: 'True', UTF8out: 'True',
    PageLang: req.lang ?? 'HEB',
    Order: req.orderRef,
    Info: req.description,
    ...(req.buyerName ? { ClientName: req.buyerName } : {}),
    ...(req.buyerEmail ? { email: req.buyerEmail, sendemail: 'True' } : {}),
  });
  const res = await outboundFetch(signUrl, { timeoutMs: 20_000 });
  if (!res.ok) throw new Error(`hyp: sign failed, HTTP ${res.status}`);
  const body = (await res.text()).trim();
  const signed = parseHypResponse(body);
  // A refusal comes back as a normal 200 carrying an error CCode, so the status code alone says
  // nothing. `signature` present is the only proof the request was actually signed.
  if (!signed.signature) throw new Error(`hyp: sign returned no signature (CCode=${signed.CCode ?? '—'})`);
  return { url: `${creds.baseUrl}?${body}`, signed };
}

/**
 * Step 3 — ask Hyp whether the redirect we just received is genuinely theirs.
 *
 * Every parameter goes back exactly as it arrived, in the order it arrived: Hyp verifies the
 * signature over that sequence, so re-ordering or dropping one fails a legitimate payment. Hence
 * the caller passes the parsed URL params rather than a hand-picked subset.
 */
export async function verifyRedirect(
  params: Iterable<[string, string]>,
  creds: HypCredentials,
): Promise<boolean> {
  const qs = new URLSearchParams({ action: 'APISign', What: 'VERIFY', Masof: creds.masof, KEY: creds.key, PassP: creds.passp });
  for (const [k, v] of params) qs.append(k, v);
  const answer = await callHyp(`${creds.baseUrl}?${qs.toString()}`);
  return answer.CCode === HYP_OK;
}

/** Step 4 — the card token for the authorization identified by `transId` (the redirect's `Id`). */
export async function fetchCardToken(transId: string, creds: HypCredentials): Promise<{ token: string; expiry: string }> {
  const answer = await callHyp(buildUrl(creds.baseUrl, { action: 'getToken', Masof: creds.masof, PassP: creds.passp, TransId: transId }));
  if (answer.CCode !== HYP_OK || !answer.Token) throw new Error(`hyp: getToken failed (CCode=${answer.CCode ?? '—'})`);
  return { token: answer.Token, expiry: answer.Tokef ?? '' };
}

export interface CaptureAuthorization {
  /** From the redirect: `ACode`, `UID`, `UserId`. */
  authCode: string;
  originalUid: string;
  buyerIsraeliId?: string;
  buyerName?: string;
  token: string;
  /** `Tokef` exactly as `getToken` returned it — **YYMM**, not MMYY. See `splitTokef`. */
  tokenExpiry: string;
  /** What was held, in agorot. */
  authorizedAgorot: number;
  /** What to actually take. Must be ≤ authorized — Hyp allows less, never more. */
  captureAgorot: number;
  description: string;
}

/** Step 5 — take the money. The irreversible step, and `checkout.ts` runs it only after the
 *  order rows exist. Refuses locally to over-capture rather than letting Hyp decide: their answer
 *  to "more than authorized" depends on terminal configuration, so the same code would succeed on
 *  one terminal and fail on another, which is the worst possible shape for a money path. */
export async function captureAuthorization(cap: CaptureAuthorization, creds: HypCredentials): Promise<HypResponse> {
  if (cap.captureAgorot > cap.authorizedAgorot) throw new Error('hyp: capture exceeds authorized amount');
  const answer = await callHyp(buildUrl(creds.baseUrl, {
    action: 'soft', Masof: creds.masof, PassP: creds.passp,
    UserId: cap.buyerIsraeliId || '000000000',   // Hyp's documented placeholder when no ID was collected.
    ClientName: cap.buyerName ?? '',
    Token: 'True', CC: cap.token,
    Tmonth: splitTokef(cap.tokenExpiry).month, Tyear: splitTokef(cap.tokenExpiry).year,
    AuthNum: cap.authCode,
    Amount: shekels(cap.captureAgorot),
    'inputObj.originalAmount': String(cap.authorizedAgorot),   // agorot here, shekels above. See the header.
    'inputObj.originalUid': cap.originalUid,
    'inputObj.authorizationCodeManpik': '7',                   // Static, per Hyp's docs.
    Info: cap.description,
  }));
  if (answer.CCode !== HYP_OK) throw new Error(`hyp: capture refused (CCode=${answer.CCode ?? '—'})`);
  return answer;
}

/** Step 6 — release a hold that will never be captured. Returns false when Hyp says the window
 *  has closed (920), so the caller can escalate to a refund instead of assuming the money is
 *  back: a released hold and a transmitted charge look identical to a buyer only until the
 *  statement arrives. */
export async function cancelTransaction(transId: string, creds: HypCredentials): Promise<{ cancelled: boolean; code: string }> {
  const answer = await callHyp(buildUrl(creds.baseUrl, { action: 'CancelTrans', Masof: creds.masof, PassP: creds.passp, TransId: transId }));
  return { cancelled: answer.CCode === HYP_OK, code: answer.CCode ?? '' };
}
