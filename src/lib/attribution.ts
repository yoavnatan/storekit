/**
 * First-party ad attribution — which click produced this order (GO_LIVE_CHECKLIST.md §2.5, layer 5).
 *
 * The whole mechanism is three steps and this module owns all three, so nothing else has to know
 * the parameter names, the cookie format or the window:
 *
 *   1. `captureAttribution` — middleware, on every human page GET. If the landing URL carries a
 *      click id or UTM tags, they are written to a first-party cookie.
 *   2. `readAttribution` — `/api/checkout`, at the moment the orders are created. Returns the
 *      record if it is still inside the lookback window.
 *   3. The record is stamped on every order of that checkout (`orders.attribution`, migration 0010)
 *      and stays there.
 *
 * **Why this exists at all.** The "sales" number on a campaign card is an ATTRIBUTION and not a
 * count of orders — `lib/ad-metrics.ts` (`RangeStat.conversions`) states the rule in full. Google
 * and Meta each join their own click log to a pixel, each MODELS the joins it cannot make, and both
 * can claim the same sale, so summing campaigns can exceed the store's real order count. Stamping
 * the click on the order is the only deterministic version: "sales from this campaign" becomes a
 * `WHERE` over real rows. It does not fix everything — a click on a phone and a purchase on a
 * desktop, or cleared cookies, still break the join — but what it does report is then a fact.
 *
 * **Nothing reads these rows yet, and that is deliberate.** Until the real ad accounts exist (§2.1)
 * no link on the internet carries these parameters, so every seller-facing number stays the
 * deterministic mock it is today; wiring a true `0` in beside mock thousands would be worse than
 * either. Capture had to come first regardless: attribution can only ever be recorded at the moment
 * it happens, so a month of orders placed before this shipped is a month that can never be
 * attributed retroactively.
 *
 * **Last click wins, and the record is replaced WHOLE.** A landing that carries attribution
 * overwrites whatever was there, with a fresh `landedAt`; it is never merged into the previous one.
 * Both networks attribute to the last click, so overwriting is what keeps our number comparable to
 * theirs — and a merged record would be the double-claiming §2.5 warns about, expressed in our own
 * database: one order credited to a Google campaign AND to a newsletter at the same time.
 *
 * **A landing with NO parameters changes nothing.** It must not clear the cookie: the entire point
 * of a lookback window is the buyer who clicks the ad, leaves, and comes back days later through
 * the front door to buy. That visit is exactly the one being measured.
 *
 * **Everything here is untrusted input, on both ends.** The query string is attacker-controlled by
 * definition, and so is the cookie — a cookie is client state, and `httpOnly` stops our own scripts
 * from reading it, not a person from writing one. So values are re-validated on the way OUT of the
 * cookie exactly as strictly as on the way in: type, control characters, length, and the window.
 * Nothing downstream may assume a value here was ever seen by an ad network.
 */
import type { AstroCookies } from 'astro';

/** First-party, `httpOnly` — no client script has any reason to read it, and the pixels do their
 *  own thing in the page. `sameSite: 'lax'` is REQUIRED, not a default copied from `sn_vid`: the
 *  visitor arrives here by a top-level navigation FROM google.com or facebook.com, and `strict`
 *  would withhold the cookie on exactly the request that matters. */
export const ATTRIBUTION_COOKIE = 'sn_attr';

/**
 * Lookback window, in days.
 *
 * 30 is Google Ads' default click window and the longer of the two we report against (Meta's is
 * 7-day-click + 1-day-view). The cookie holds ONE window because it holds one record, so it has to
 * be the longer one — a 7-day cookie could not answer a Google question at all, while a 30-day
 * cookie answers both: `landedAt` is stored on the order, so a Meta report narrows itself at read
 * time instead of needing a second cookie.
 *
 * Changing this number changes which past orders count as attributed. §2.5 requires the window to
 * be fixed EXPLICITLY in both ad accounts and written down; this constant is our half of that pair.
 */
export const ATTRIBUTION_WINDOW_DAYS = 30;

const WINDOW_MS = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Per-value cap. Real click ids run ~100 characters and UTM tags far less, so this is an
 *  anti-abuse bound and not a limit anything legitimate meets: it stops a crafted URL from writing
 *  a kilobyte into a cookie that then rides on every subsequent request and lands in an order row. */
const MAX_VALUE_LEN = 128;

/** Hard ceiling on the encoded cookie. Past this the record is dropped rather than truncated —
 *  half a click id is not a click id, and a value that silently lost its tail would join to nothing
 *  while looking like a real attribution. */
const MAX_COOKIE_BYTES = 1024;

/** Tolerated clock skew on `landedAt`. A timestamp further ahead than this is forged (a cookie the
 *  visitor wrote themselves), and left unchecked it would keep one attribution alive forever. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * One landing's attribution. Every field except `landedAt` is optional and absent-rather-than-null,
 * matching how `Order`'s own optional fields are built.
 */
export interface OrderAttribution {
  /** Google Ads click id. */
  gclid?: string;
  /** Google's iOS replacements for `gclid` when ATT consent is absent — app-to-web (`gbraid`) and
   *  web-to-web (`wbraid`). A campaign whose mobile half arrives under these and is not captured
   *  does not look partially measured, it looks like it did not convert. */
  gbraid?: string;
  wbraid?: string;
  /** Meta click id. */
  fbclid?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  /**
   * ISO timestamp of the landing. Required, and it is what makes a lookback window expressible at
   * all: Google counts 30 days from the click and Meta 7, so a report comparing our numbers to
   * theirs has to ask "how long before this order was the click" PER NETWORK. Without it the
   * cookie's own TTL would silently impose one window on both.
   */
  landedAt: string;
}

/** Query parameter → field. The parameter names are fixed by Google/Meta/the UTM convention; the
 *  field names are ours. This map is the only place the two vocabularies meet, and both the URL
 *  reader and the cookie reader walk it, which is what keeps them from drifting apart. */
const PARAM_TO_FIELD = {
  gclid: 'gclid',
  gbraid: 'gbraid',
  wbraid: 'wbraid',
  fbclid: 'fbclid',
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  utm_content: 'utmContent',
  utm_term: 'utmTerm',
} as const satisfies Record<string, keyof OrderAttribution>;

type AttributionParam = keyof typeof PARAM_TO_FIELD;
type AttributionField = (typeof PARAM_TO_FIELD)[AttributionParam];

const PARAMS = Object.keys(PARAM_TO_FIELD) as AttributionParam[];

/**
 * Untrusted string → a value fit to store, or `null`.
 *
 * Control characters are stripped rather than rejected: a UTM tag is free text a marketer types, so
 * a stray tab or newline pasted out of a spreadsheet is a mistake, and losing a real click over it
 * would be the wrong trade. Everything that is not a mistake — wrong type, empty, over-length — is
 * refused outright. Nothing is escaped here for a sink: the value reaches Postgres as a bound
 * parameter, and reaches a screen through the same escaping every other untrusted string does.
 */
function cleanValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- removing control characters is the point.
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!cleaned || cleaned.length > MAX_VALUE_LEN) return null;
  return cleaned;
}

/**
 * Builds a record from whatever `get` supplies, dropping every field that does not clean. `null`
 * when nothing survived — "no attribution" and "an attribution holding only a timestamp" must not
 * be two different states downstream.
 */
function recordFrom(get: (param: AttributionParam) => unknown, landedAt: string): OrderAttribution | null {
  const record: Partial<Record<AttributionField, string>> = {};
  let any = false;
  for (const param of PARAMS) {
    const value = cleanValue(get(param));
    if (value === null) continue;
    record[PARAM_TO_FIELD[param]] = value;
    any = true;
  }
  return any ? { ...record, landedAt } : null;
}

/**
 * Read a landing URL's attribution parameters. `null` when the URL carries none — the common case,
 * and the one that must leave an existing cookie alone.
 */
export function parseLandingAttribution(url: URL, now: number = Date.now()): OrderAttribution | null {
  return recordFrom((param) => url.searchParams.get(param), new Date(now).toISOString());
}

/** Record → cookie value. base64url, so the result is safe in a cookie and survives the
 *  encode/decode round trip a cookie library performs unchanged — raw JSON would be percent-encoded
 *  on the way out and would depend on the library decoding it identically on the way back. */
export function encodeAttribution(record: OrderAttribution): string {
  return Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
}

/**
 * Any already-parsed value → a valid record, or `null`. **No window is applied here**, and that is
 * the distinction between this and `decodeAttribution`: the window decides whether a click may
 * still claim a NEW purchase, while a record already stamped on an order is a historical fact that
 * must keep reading back the same way in a year. Applying the window here would quietly empty the
 * attribution of every order older than a month.
 *
 * Used for both ends that hand over an object rather than a cookie string: the decoded cookie
 * below, and the `jsonb` column on the way out of the database — re-validated there too rather than
 * trusted for having been in our own column, so a row written by a hand-edit or an older shape
 * degrades to "no attribution" instead of putting a malformed record on an order.
 */
export function sanitizeAttribution(value: unknown): OrderAttribution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;

  const landedAtRaw = cleanValue(obj['landedAt']);
  if (!landedAtRaw) return null;
  const landedMs = Date.parse(landedAtRaw);
  if (!Number.isFinite(landedMs)) return null;

  // Looked up by FIELD name — a stored record holds our shape, a URL holds Google's — but through
  // the same `recordFrom`, so one set of cleaning rules covers both directions.
  return recordFrom((param) => obj[PARAM_TO_FIELD[param]], new Date(landedMs).toISOString());
}

/**
 * Cookie value → record still eligible to claim a purchase, or `null`.
 *
 * Everything is re-validated, because this input did not become trustworthy for having been in a
 * cookie. On top of `sanitizeAttribution`'s checks, `landedAt` must be inside the lookback window
 * and must not be in the future — an unchecked future timestamp is a cookie the visitor wrote
 * themselves, and it would keep one attribution alive forever. Malformed input of any kind — not
 * base64, not JSON, not an object — is `null` and never a throw: this runs inside checkout and must
 * not be able to fail a purchase.
 */
export function decodeAttribution(value: string | undefined, now: number = Date.now()): OrderAttribution | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const record = sanitizeAttribution(parsed);
  if (!record) return null;
  const landedMs = Date.parse(record.landedAt);
  if (landedMs > now + FUTURE_SKEW_MS) return null;
  if (now - landedMs > WINDOW_MS) return null;
  return record;
}

/**
 * Middleware step: if this landing carries attribution, persist it. Returns what it wrote (or
 * `null`) for the tests' benefit; the caller is one line in the request path and never branches
 * on it.
 */
export function captureAttribution(url: URL, cookies: AstroCookies, now: number = Date.now()): OrderAttribution | null {
  const record = parseLandingAttribution(url, now);
  if (!record) return null;
  const encoded = encodeAttribution(record);
  // Dropped whole rather than trimmed to fit — see MAX_COOKIE_BYTES. A landing that produces this
  // is a crafted URL, so the honest outcome is no attribution rather than a plausible-looking one.
  if (Buffer.byteLength(encoded, 'utf8') > MAX_COOKIE_BYTES) return null;
  cookies.set(ATTRIBUTION_COOKIE, encoded, {
    path: '/',
    maxAge: Math.floor(WINDOW_MS / 1000),
    httpOnly: true,
    sameSite: 'lax',
  });
  return record;
}

/** Checkout step: the attribution to stamp on the orders this request is about to create, or
 *  `null` for an organic purchase. */
export function readAttribution(cookies: AstroCookies, now: number = Date.now()): OrderAttribution | null {
  return decodeAttribution(cookies.get(ATTRIBUTION_COOKIE)?.value, now);
}
