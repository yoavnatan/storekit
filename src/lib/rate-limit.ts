import { firstRow, query } from './db.js';

/**
 * Failed-sign-in throttling.
 *
 * Every credential surface here was, until 2026-08-04, guessable at whatever rate the network
 * allowed. The rationale for the storage shape (Postgres, one row per bucket, fixed window,
 * failures only) is on the table itself — `migrations/0009_auth_attempts.sql` — and is not repeated
 * here. What this file owns is the POLICY: what a bucket is called, how many failures each surface
 * tolerates, and the fact that the check happens before the password is ever verified.
 *
 * **Two buckets are checked per attempt, and they answer different questions.**
 *   identity (`login:<email>`) — protects ONE account from being ground down. The attacker cannot
 *                                dodge it by changing address, because the address is the target.
 *   origin   (`ip:<addr>`)     — protects EVERY account from one source spraying one password
 *                                across many addresses, which the identity bucket cannot see at all
 *                                (each address gets its own row, each with a single failure).
 * Its limit is deliberately looser: an office, a campus or a mobile carrier NAT puts real,
 * unrelated sellers behind one address, and a tight per-IP limit locks out the innocent majority.
 *
 * **A blocked attempt never reaches the password check.** That is the point — the cost being
 * defended against is bcrypt's, and a limiter that verifies first and refuses afterwards still pays
 * it. It also means the caller must ask BEFORE doing any work, then report the outcome:
 *
 *   const gate = await checkAuthRate(buckets);        // ask
 *   if (!gate.allowed) → tell the user, stop
 *   ... verify credentials ...
 *   ok ? await clearAuthRate(buckets)                 // success wipes the slate
 *      : await countAuthAttempt(buckets);            // failure counts
 *
 * **Not applied to the Google OAuth route.** There is no secret to guess there — the credential is
 * verified by Google, and the callback carries a code we issued. Rate-limiting it would throttle a
 * flow with no brute-force surface.
 */

/** One surface's policy. `windowSec` is a FIXED window: the first failure starts it, and it rolls
 *  forward as a whole once expired (see the migration for why not a sliding log). */
export interface RateLimitRule {
  bucket: string;
  limit: number;
  windowSec: number;
}

/** Per-account. Eight is comfortably above real typo-then-retry behaviour and far below anything a
 *  dictionary needs; the window is long enough that "wait it out" is not a strategy. */
const IDENTITY_LIMIT = 8;
/** Per-source. Loose because of shared NAT (see the header) — it is the backstop for spraying
 *  across many addresses, not the primary defence for any one of them. */
const ORIGIN_LIMIT = 30;
/** The admin password is one shared secret with no second factor and full read access to every
 *  seller's data, so it gets the tightest limit on the platform. There is no identity to key on —
 *  the address is the only thing an attempt carries. */
const ADMIN_LIMIT = 5;
const WINDOW_SEC = 15 * 60;

/**
 * The longest window ANY rule on the platform uses — the purge job's cut-off, and nothing else.
 *
 * It exists because the purge used to delete by `WINDOW_SEC`, i.e. by the window of the surface
 * this file was written for. That was correct only for as long as this file was the only caller.
 * `lib/message-flood.ts` (2026-08-10) buckets over an hour, and a 15-minute purge would have
 * deleted its rows at minute 16 — a limiter that silently stops limiting, with a green test suite
 * and no error anywhere. Purging is size management only (an expired row is already invisible to
 * `checkAuthRate`), so erring long costs a handful of rows and erring short costs the feature.
 * `tests/message-flood.test.ts` fails if any rule builder returns a longer window than this.
 */
export const MAX_RATE_WINDOW_SEC = 60 * 60;

/**
 * Lower-cased and trimmed so `A@b.com ` and `a@b.com` share one row — otherwise the identity bucket
 * is bypassed by changing the case of a letter.
 *
 * **Length-capped, and that cap is load-bearing** (measured against the real database, 2026-08-04):
 * `bucket` is the primary key, and a btree entry may not exceed 2704 bytes. The login form does not
 * validate the address before the limiter sees it — it must not, because the limiter has to run
 * before any work — so an unauthenticated POST carrying a ~5000-character `email` made the INSERT
 * fail with `index row size 5024 exceeds btree version 4 maximum`, i.e. a 500 on the sign-in page,
 * reachable by anyone, with a one-line request. 254 is the RFC 5321 maximum for a real address, so
 * nothing legitimate is truncated; the same class as the length cap in `lib/email-address.ts` and
 * the 45-character cap in `lib/client-ip.ts`, and the reason both exist.
 */
function identityKey(email: string): string {
  return email.trim().toLowerCase().slice(0, 254);
}

export function sellerLoginRules(email: string, ip: string): RateLimitRule[] {
  return [
    { bucket: `login:${identityKey(email)}`, limit: IDENTITY_LIMIT, windowSec: WINDOW_SEC },
    { bucket: `login-ip:${ip}`, limit: ORIGIN_LIMIT, windowSec: WINDOW_SEC },
  ];
}

/** Registration is throttled by ORIGIN only. There is no account to protect yet, and keying on the
 *  submitted address would let anyone lock a competitor out of signing up by burning their address
 *  first. What is being limited here is the enumeration ("is this address taken?") and mass account
 *  creation, both of which are per-source behaviours. */
export function registerRules(ip: string): RateLimitRule[] {
  return [{ bucket: `register-ip:${ip}`, limit: ORIGIN_LIMIT, windowSec: WINDOW_SEC }];
}

export function adminLoginRules(ip: string): RateLimitRule[] {
  return [{ bucket: `admin-ip:${ip}`, limit: ADMIN_LIMIT, windowSec: WINDOW_SEC }];
}

/**
 * Coupon-code lookup, by ORIGIN only.
 *
 * Not a credential, and that is exactly why it is here rather than in a mechanism of its own: a
 * coupon code is a short, human-typable secret checked by an endpoint anyone can call, which is
 * the same guessing surface a password has and none of bcrypt's cost to slow it down. Left open,
 * a script walks `SAVE10`, `SAVE15`, `SUMMER20` against a store until something works, and the
 * seller finds out from their margin.
 *
 * Failures only, per the file's own protocol, so a buyer who types their real code correctly never
 * writes a row. The limit is the loose origin one for the NAT reason above — several shoppers on
 * one office address must not lock each other out over a typo — and the bucket is per STORE as
 * well as per address, because guessing is a per-store activity and the cap should not be spent by
 * an unrelated shop's shoppers.
 */
export function couponLookupRules(storeSlug: string, ip: string): RateLimitRule[] {
  return [{ bucket: `coupon:${storeSlug.slice(0, 120)}:${ip}`, limit: ORIGIN_LIMIT, windowSec: WINDOW_SEC }];
}

/** Fault/content reports one address may file per hour (`/api/report`). */
const REPORTS_PER_HOUR = 10;
/** Its own constant rather than {@link MAX_RATE_WINDOW_SEC}, which happens to be the same number
 *  today: that one is the PURGE's cut-off, and a rule that reads it would silently follow it if it
 *  ever moved. */
const REPORT_WINDOW_SEC = 60 * 60;

/**
 * "דווח על תקלה" — the one write path on the platform a signed-out visitor may use, which is the
 * whole reason it needs a bucket at all.
 *
 * **This is the one rule where SUCCESSES are counted, not failures**, and the difference is the
 * point rather than an inconsistency. Everywhere else in this file the thing being defended is a
 * secret and a wrong answer is the abuse; here there is no secret and no wrong answer — a flood of
 * perfectly valid reports IS the abuse, since each one lands in front of a person. So
 * `/api/report` asks first and calls `countAuthAttempt` on the accepted ones. Ten an hour is far
 * above anyone describing something that actually happened to them, and far below anything worth
 * scripting.
 *
 * Keyed on the address alone: a report needs no account, so there is no identity to key on. The
 * shared-NAT caution on `ORIGIN_LIMIT` applies, which is why the number is not tighter.
 */
export function reportRules(ip: string): RateLimitRule[] {
  return [{ bucket: `report:${ip.slice(0, 120)}`, limit: REPORTS_PER_HOUR, windowSec: REPORT_WINDOW_SEC }];
}

/** Forgot-password requests one address may trigger per window. Well above "I clicked it twice and
 *  nothing came, let me try again", and low enough that nobody can use the form to bury a seller's
 *  inbox — which is the real abuse here, since every accepted request sends a real person a mail. */
const RESET_REQUESTS_PER_WINDOW = 5;

/**
 * "שכחתי סיסמה" (`/seller/forgot-password`).
 *
 * **Successes are counted, like `reportRules` and unlike everything above** — and for the same
 * reason. There is no secret to get wrong here: every well-formed request is "valid", and a flood
 * of valid ones is the abuse. Two different abuses, in fact, which is why there are two buckets and
 * why the identity one is the tighter:
 *
 *   identity (`reset:<email>`) — mail-bombing ONE seller, and probing whether an address is
 *                                registered by watching what the form does. Neither is a
 *                                per-source behaviour; both are per-target.
 *   origin   (`reset-ip:<ip>`) — walking a list of addresses from one place, which the identity
 *                                bucket cannot see at all (one row each, one attempt each).
 *
 * Keyed on the address the caller TYPED, deliberately, and not on whether it belongs to anybody:
 * the page must behave identically for a registered and an unregistered address
 * (`lib/password-reset.ts`), and a limiter that only counts real accounts is itself the oracle.
 */
export function passwordResetRules(email: string, ip: string): RateLimitRule[] {
  return [
    { bucket: `reset:${identityKey(email)}`, limit: RESET_REQUESTS_PER_WINDOW, windowSec: WINDOW_SEC },
    { bucket: `reset-ip:${ip}`, limit: ORIGIN_LIMIT, windowSec: WINDOW_SEC },
  ];
}

/** Attempts per window at opening a case WITHOUT a session. */
const ORDER_HELP_ATTEMPTS_PER_WINDOW = 10;

/**
 * A buyer with no account opening a case on their own order (`/api/returns`, `order-access.ts`).
 *
 * The credential is an order number plus the address it was placed with — 8 random hex characters
 * and an email, so guessing means landing two unrelated secrets at once and the reference space is
 * not walkable. This bounds the trying anyway, because that is the cheap half and the endpoint
 * answers identically whether or not a pair matched: without a limiter, identical answers are still
 * a channel if you can ask fast enough.
 *
 * Counted on ATTEMPTS rather than failures, like `reportRules`: the guessing IS the traffic. Only a
 * caller with no session is counted — a signed-in buyer proved who they are before asking, and
 * their own returns must not be throttled by someone else's NAT.
 */
export function orderHelpRules(ip: string): RateLimitRule[] {
  return [{ bucket: `order-help:${ip.slice(0, 120)}`, limit: ORDER_HELP_ATTEMPTS_PER_WINDOW, windowSec: WINDOW_SEC }];
}

/** Reviews one source may ATTEMPT per window. */
const REVIEW_ATTEMPTS_PER_WINDOW = 20;

/**
 * Writing a product review (`/api/review`).
 *
 * A second lock on a door whose real bolt is elsewhere: a review needs a paid, shipped order line
 * that has not been reviewed yet (`review-eligibility.ts`), and one purchase earns exactly one
 * review by database constraint. So there is no volume of requests that produces a wall of reviews,
 * and this limiter is not what makes the feature safe.
 *
 * What it does stop is the cheap thing a limiter is for: a script hammering the endpoint with
 * guessed order ids to find one that answers differently. Failures count as well as successes —
 * the guessing IS the traffic — and the number is far above any real person, who writes at most a
 * handful of reviews after one delivery.
 */
export function reviewRules(ip: string): RateLimitRule[] {
  return [{ bucket: `review:${ip.slice(0, 120)}`, limit: REVIEW_ATTEMPTS_PER_WINDOW, windowSec: WINDOW_SEC }];
}

export interface RateVerdict {
  allowed: boolean;
  /** Whole seconds until the blocking window expires; 0 when allowed. The UI turns this into
   *  minutes — see `retryAfterMinutes`. */
  retryAfterSec: number;
}

interface AttemptRow { attempts: number; expires_in: number }

/**
 * Is this attempt allowed to proceed? Read-only — it counts nothing, so a legitimate user who signs
 * in correctly on the first try never writes to the table at all.
 *
 * A row whose window has already expired is treated as absent rather than being cleaned up here: the
 * next failure rolls the window forward in one statement anyway, and a stale row that nobody hits
 * again is the purge job's business.
 */
export async function checkAuthRate(rules: readonly RateLimitRule[]): Promise<RateVerdict> {
  let worst = 0;
  for (const rule of rules) {
    const row = await firstRow<AttemptRow>(
      `SELECT attempts,
              CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => $2) - now())))::int AS expires_in
         FROM auth_attempts
        WHERE bucket = $1 AND window_start > now() - make_interval(secs => $2)`,
      [rule.bucket, rule.windowSec],
    );
    if (row && row.attempts >= rule.limit) worst = Math.max(worst, Math.max(row.expires_in, 1));
  }
  return worst > 0 ? { allowed: false, retryAfterSec: worst } : { allowed: true, retryAfterSec: 0 };
}

/**
 * Count one failure against every bucket.
 *
 * The statement is the shape this codebase uses wherever two instances may race (§7.5, and
 * `claimCheckout`): a single `INSERT … ON CONFLICT DO UPDATE` in which the expiry test and the
 * increment are the same decision. Reading the row first and writing it back would let two parallel
 * attempts both read `attempts = 7` and both write `8`, which is how a limit of 8 becomes a limit of
 * 16 under exactly the concurrency an attacker produces.
 */
export async function countAuthAttempt(rules: readonly RateLimitRule[]): Promise<void> {
  for (const rule of rules) {
    await query(
      `INSERT INTO auth_attempts (bucket, attempts, window_start)
            VALUES ($1, 1, now())
       ON CONFLICT (bucket) DO UPDATE
              SET attempts = CASE WHEN auth_attempts.window_start > now() - make_interval(secs => $2)
                                  THEN auth_attempts.attempts + 1 ELSE 1 END,
                  window_start = CASE WHEN auth_attempts.window_start > now() - make_interval(secs => $2)
                                  THEN auth_attempts.window_start ELSE now() END`,
      [rule.bucket, rule.windowSec],
    );
  }
}

/** A correct password wipes the slate for the buckets that attempt touched, so yesterday's typos
 *  can never add up to a lockout for someone who does know their password. */
export async function clearAuthRate(rules: readonly RateLimitRule[]): Promise<void> {
  const buckets = rules.map((rule) => rule.bucket);
  if (!buckets.length) return;
  await query('DELETE FROM auth_attempts WHERE bucket = ANY($1)', [buckets]);
}

/** Rounded UP and never below 1: "try again in 0 minutes" reads as a bug, and rounding down
 *  promises an unlock that has not happened yet. */
export function retryAfterMinutes(retryAfterSec: number): number {
  return Math.max(1, Math.ceil(retryAfterSec / 60));
}

/** Drops rows whose window has lapsed. Idempotent — a second pass finds nothing. Size management
 *  only: an expired row is already invisible to `checkAuthRate`. Cut off at
 *  {@link MAX_RATE_WINDOW_SEC}, not at this file's own `WINDOW_SEC` — see that constant. */
export async function purgeExpiredAuthAttempts(): Promise<number> {
  const { rowCount } = await query(
    'DELETE FROM auth_attempts WHERE window_start < now() - make_interval(secs => $1)',
    [MAX_RATE_WINDOW_SEC],
  );
  return rowCount;
}
