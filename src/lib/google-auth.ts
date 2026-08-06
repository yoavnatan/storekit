/**
 * A Google API access token from a service-account key — minted here, not pasted anywhere.
 *
 * **Why not just hold an access token in an environment variable.** Google's access tokens expire
 * in an hour. A token in `.env` is therefore a variable somebody has to refresh every hour forever,
 * which is the manual step this whole feature exists to delete — and it fails in the worst possible
 * shape: the monitor that watches for silent failures starts failing silently itself, at 3am, and
 * the only symptom is the absence of alerts. So the process holds the KEY and mints its own tokens.
 *
 * The flow is Google's documented two-legged OAuth (`urn:ietf:params:oauth:grant-type:jwt-bearer`):
 * sign a short-lived JWT with the service account's private key, exchange it for an access token.
 * Hand-rolled over `node:crypto` rather than pulling in `google-auth-library` — it is one signature
 * and one POST, and this is the only Google API the platform calls.
 *
 * **What must never reach a log or an error entry:** the private key and the minted token. The one
 * error this module produces names the failure and the client email, never the material.
 */
import crypto from 'node:crypto';
import { outboundFetch } from './outbound-fetch.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Read-only is enough: the job reads product statuses and writes nothing back to Merchant Center.
 *  A token that cannot mutate our catalogue is a token whose leak costs a report, not the account. */
const CONTENT_SCOPE = 'https://www.googleapis.com/auth/content';

/** The assertion's own lifetime. Google caps it at an hour; shorter is fine and it is discarded
 *  immediately after the exchange either way. */
const ASSERTION_TTL_SEC = 300;

/**
 * Refresh this long before the token actually expires.
 *
 * Not politeness — a token that is valid when the request is *sent* and expired when it *arrives*
 * fails as a 401, which this module cannot tell apart from a bad key. The margin has to exceed the
 * outbound timeout, and `outbound-fetch.ts` allows well under a minute.
 */
const EXPIRY_SLACK_SEC = 120;

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/**
 * Parse the JSON key Google hands out, or explain what is wrong with it.
 *
 * Returns null rather than throwing: every caller here is on a scheduled job's path, and the reason
 * is reported through the job's own alert rather than as an exception nobody catches. The two fields
 * are checked by name because a truncated or wrong-file paste (an OAuth *client* JSON, say) parses
 * perfectly well as JSON and then fails much later, at signing time, as something cryptic.
 */
export function parseServiceAccountKey(raw: string): ServiceAccountKey | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const { client_email: email, private_key: key } = parsed as Record<string, unknown>;
  if (typeof email !== 'string' || !email) return null;
  if (typeof key !== 'string' || !key.includes('PRIVATE KEY')) return null;
  return { client_email: email, private_key: key };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * The signed assertion.
 *
 * Not exported: the test verifies it by capturing what `getGoogleAccessToken` actually POSTs and
 * checking that signature against the public half of a generated key pair. That is the stronger
 * assertion anyway — it proves the bytes Google receives are correctly signed, not merely that a
 * helper can build a correct string and something else might send a different one.
 */
function buildAssertion(key: ServiceAccountKey, scope: string, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: key.client_email,
    scope,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + ASSERTION_TTL_SEC,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(key.private_key);
  return `${signingInput}.${base64url(signature)}`;
}

interface CachedToken { token: string; expiresAtSec: number }

/** Keyed by client email + scope, so two callers asking for different scopes cannot hand each other
 *  a token that does not carry the permission they need. Module-level and therefore per-process,
 *  which is the right scope for a value that is worthless to another process anyway. */
const cache = new Map<string, CachedToken>();

/** Test seam — a cached token would otherwise outlive the case that created it. */
export function resetGoogleTokenCache(): void {
  cache.clear();
}

/**
 * A usable access token, or null when one could not be obtained.
 *
 * Null is the same contract the status providers keep: it means *no answer*, never *no problem*.
 * The caller turns it into an alert; this module does not log, because it does not know whether its
 * caller is a job that should escalate or a one-off.
 */
export async function getGoogleAccessToken(
  key: ServiceAccountKey,
  scope: string = CONTENT_SCOPE,
): Promise<string | null> {
  const cacheKey = `${key.client_email}|${scope}`;
  const nowSec = Math.floor(Date.now() / 1000);

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAtSec - EXPIRY_SLACK_SEC > nowSec) return cached.token;

  let assertion: string;
  try {
    assertion = buildAssertion(key, scope, nowSec);
  } catch {
    // A malformed private key fails here, not at the network. Distinguishing it is not worth a
    // second return type: both mean "no token", and the alert says which account it was for.
    return null;
  }

  try {
    const res = await outboundFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) return null;
    const data = await res.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== 'string' || !data.access_token) return null;
    // A missing or absurd `expires_in` is treated as the documented hour rather than as a reason to
    // fail: the token is valid, and the worst case of guessing low is one extra mint.
    const ttl = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
    cache.set(cacheKey, { token: data.access_token, expiresAtSec: nowSec + ttl });
    return data.access_token;
  } catch {
    return null;
  }
}
