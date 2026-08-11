import type { AstroCookies } from 'astro';
import { checkAuthRate, countAuthAttempt, retryAfterMinutes, type RateLimitRule } from './rate-limit.js';
import { getLang, getT } from '../i18n/index.js';

/**
 * Flood control for buyer ↔ seller messaging — SYMMETRIC, because both sides can do it.
 *
 * Until this module the only ceiling on `/api/messages` was how long one message may be. A buyer
 * could open a hundred threads against one shop, or a seller could push a hundred replies into a
 * buyer's inbox, and every one of them also wrote a notification row and lit a badge. The seller
 * side matters as much as the buyer side and is the one people forget: the seller is the party with
 * a dashboard, a reason to chase, and (once ads exist) a motive.
 *
 * **Two different limits, because there are two different floods.**
 *
 * 1. **A run inside one thread** (`MAX_UNANSWERED_IN_THREAD`) — how many messages you may send in a
 *    row before the other side says anything back. This is the one that actually shapes behaviour,
 *    and it is deliberately not a clock: waiting fifteen minutes does not make a tenth unanswered
 *    message reasonable, and answering makes the first one fine. It needs no storage at all — the
 *    thread already knows who wrote what — so it costs one pass over rows the endpoint has in hand,
 *    it cannot be reset by signing out, and it survives any number of app instances. It is also the
 *    half a rate limit cannot express: a limit of 20/hour still lets one person drop 20 messages
 *    into one conversation.
 *
 * 2. **A rate, per sender** — the backstop against the shapes a per-thread rule cannot see: many
 *    threads to one shop (`msg-open`), and volume across everything (`msg-send`). Same fixed-window
 *    Postgres counter the credential surfaces use (`rate-limit.ts`), for the same reason: a `Map` in
 *    module scope doubles every limit the day a second instance runs.
 *
 * **These buckets count SUCCESSES, and that is the opposite of `rate-limit.ts`'s own protocol.**
 * There, only failures count and a correct password wipes the row, because the thing being limited
 * is guessing. Here the thing being limited is the successful send itself, so the counter goes up
 * after the message is written and nothing ever clears it — the window expiring is the only reset.
 * The table does not care (`0009_auth_attempts.sql`: "this table only counts"), but a reader of the
 * limiter would, which is why it is said here rather than left to be inferred.
 *
 * **The windows here are longer than every auth window, and that is load-bearing** — see
 * `MAX_RATE_WINDOW_SEC` in `rate-limit.ts`. The purge job used to delete any row older than the
 * 15-minute auth window, which would have wiped an hour-long message bucket at minute 16 and turned
 * this whole file into decoration. `tests/message-flood.test.ts` pins that no rule outlives it.
 */

const HOUR_SEC = 60 * 60;

/**
 * Messages one side may send in a row before the other side replies.
 *
 * Five, not two: a real person legitimately follows up ("also — what size?", "sorry, wrong photo"),
 * and a cap that fires on the second message reads as the platform policing an ordinary
 * conversation. Five in a row with no answer is no longer a conversation from either direction.
 * The root message counts as part of its author's run.
 */
export const MAX_UNANSWERED_IN_THREAD = 5;

/** New conversations one person may open against ONE store per hour. Per store, not global: a
 *  shopper comparing six shops in an evening is normal; six threads at one shop is the flood. */
const NEW_THREADS_PER_STORE = 3;

/** Total messages one account may send per hour, threads and replies together. High enough that a
 *  seller working through a morning's inbox never sees it, low enough to bound a script. */
const MESSAGES_PER_HOUR = 20;

/** Bounded before it becomes a primary key — the `auth_attempts.bucket` btree rejects an entry over
 *  2704 bytes, which is how a long unvalidated field turned into a public 500 once already
 *  (`rate-limit.ts#identityKey`). Ids reaching here are uuids or short guest ids; nothing real is
 *  truncated. */
function key(value: string): string {
  return value.slice(0, 120);
}

/** Opening a NEW thread: both the per-store ceiling and the overall one. */
export function newThreadRules(userId: string, storeId: string): RateLimitRule[] {
  return [
    { bucket: `msg-open:${key(userId)}:${key(storeId)}`, limit: NEW_THREADS_PER_STORE, windowSec: HOUR_SEC },
    { bucket: `msg-send:${key(userId)}`, limit: MESSAGES_PER_HOUR, windowSec: HOUR_SEC },
  ];
}

/** Replying inside an existing thread: the overall ceiling only. The per-thread shape is the run
 *  rule below, which is a better answer than a clock for a conversation already under way. */
export function replyRules(userId: string): RateLimitRule[] {
  return [{ bucket: `msg-send:${key(userId)}`, limit: MESSAGES_PER_HOUR, windowSec: HOUR_SEC }];
}

/**
 * How many messages at the END of a thread were written by `userId` — the run the next message
 * would extend.
 *
 * `entries` is the whole thread oldest-first, root included. Anything the other side wrote resets
 * the count to zero, which is the entire policy: the cap is on being ignored, not on being chatty.
 */
export function unansweredRun(entries: readonly { fromUserId: string }[], userId: string): number {
  let run = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.fromUserId !== userId) break;
    run++;
  }
  return run;
}

export interface FloodVerdict {
  /** `true` when the message may be written. */
  allowed: boolean;
  /** Which rule refused, so the caller can pick the sentence that explains it. */
  reason?: 'run' | 'rate';
  /** Minutes until the rate window frees up; 0 for a `run` refusal, which no clock resolves. */
  retryMinutes: number;
}

const OK: FloodVerdict = { allowed: true, retryMinutes: 0 };

/**
 * Ask before writing. Read-only — nothing is counted here, so the caller must call
 * {@link countMessageSent} once the message actually lands.
 *
 * Split ask/count rather than a single "consume" call for the reason the auth limiter is split: the
 * send can still fail validation, hit a missing store or lose its transaction after this point, and
 * a refusal that was never delivered must not spend the sender's allowance.
 *
 * Check-then-act, and knowingly so: two sends racing can both be allowed, so the real ceiling is the
 * limit plus however many requests one person has in flight. The counting statement itself is
 * atomic, and the thing being bounded is a person's message volume rather than a balance — the cost
 * of the race is one extra message, and the cost of closing it is a lock on every send.
 */
export async function checkMessageFlood(
  rules: readonly RateLimitRule[],
  entries: readonly { fromUserId: string }[],
  userId: string,
): Promise<FloodVerdict> {
  if (unansweredRun(entries, userId) >= MAX_UNANSWERED_IN_THREAD) {
    return { allowed: false, reason: 'run', retryMinutes: 0 };
  }
  const gate = await checkAuthRate(rules);
  if (gate.allowed) return OK;
  return { allowed: false, reason: 'rate', retryMinutes: retryAfterMinutes(gate.retryAfterSec) };
}

/** Count one delivered message against its buckets. Called AFTER the write, never before. */
export async function countMessageSent(rules: readonly RateLimitRule[]): Promise<void> {
  await countAuthAttempt(rules);
}

/**
 * The refusal, as an HTTP answer in the SENDER's own language.
 *
 * Here rather than at a route because there are two routes and three clients, and every one of them
 * shows `error` verbatim: one sentence per rule, or three wordings of one rule within a month. 429
 * with `Retry-After` and not 400 — this is "not now", not "not ever", and a client that wants to
 * re-enable a button at the right moment needs the number.
 *
 * The sender's language is the correct one to use and it is worth saying why, since the notification
 * titles in the same flow deliberately do the opposite (`lib/notification-copy.ts`): this text
 * answers the request that was just made, by the person who just made it.
 */
export function floodRefusal(verdict: FloodVerdict, cookies: AstroCookies): Response {
  const t = getT(getLang(cookies)).messages;
  const text = verdict.reason === 'run'
    ? t.floodRun
    : verdict.retryMinutes <= 1
      ? t.floodRateOne
      : t.floodRate.replace('{minutes}', String(verdict.retryMinutes));
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (verdict.retryMinutes > 0) headers['Retry-After'] = String(verdict.retryMinutes * 60);
  return new Response(JSON.stringify({ error: text }), { status: 429, headers });
}
