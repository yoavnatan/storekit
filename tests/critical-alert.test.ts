/**
 * The mail that goes out when a buyer could not pay.
 *
 * Almost every test here is about a mail NOT being sent, and that is the right proportion. An alert
 * channel is only worth having while it is believed, and these die of noise rather than silence:
 * one broken deploy sends four hundred mails, the recipient makes a filter rule, and the next
 * genuine alert lands in a folder nobody opens. The limits ARE the feature, so the limits are what
 * is pinned.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setDatabase, type Database, type Queryable } from '../src/lib/db.js';
import { alertOnCriticalError, resetAlertBudget } from '../src/lib/critical-alert.js';
import * as email from '../src/lib/email/index.js';

/** The numbers `critical-alert.ts` declares, duplicated so that changing one is a decision. */
const MAX_ALERTS_PER_HOUR = 10;

/** A database whose critical-count answer is `count`, i.e. "this many criticals on this route in
 *  the window, INCLUDING the one that just triggered the alert". */
function dbReturningCount(count: number) {
  const queryable: Queryable = { query: async () => ({ rows: [{ n: count }], rowCount: 1 }) as never };
  const db: Database = { query: queryable.query, transaction: (run) => run(queryable), close: async () => {} };
  setDatabase(db);
}

function dbThatFails() {
  const queryable: Queryable = { query: async () => { throw new Error('database is down'); } };
  const db: Database = { query: queryable.query, transaction: (run) => run(queryable), close: async () => {} };
  setDatabase(db);
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    severity: 'critical',
    createdAt: '2026-08-05T10:00:00.000Z',
    route: '/api/checkout',
    message: 'charge declined',
    ...overrides,
  } as Parameters<typeof alertOnCriticalError>[0];
}

function spySend() {
  return vi.spyOn(email, 'sendEmail').mockResolvedValue({ ok: true, provider: 'test' });
}

afterEach(() => {
  setDatabase(undefined);
  resetAlertBudget();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('alertOnCriticalError', () => {
  it('sends for the first critical error on a route', async () => {
    vi.stubEnv('ALERT_EMAIL', 'owner@example.com');
    dbReturningCount(1); // only this one
    const send = spySend();

    await alertOnCriticalError(entry());

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]![0];
    expect(message.to).toBe('owner@example.com');
    // The route belongs in the subject: a phone shows the subject and nothing else, and "where" is
    // what decides whether this is worth opening now.
    expect(message.subject).toContain('/api/checkout');
    expect(message.html).toContain('charge declined');
  });

  it('stays silent when no recipient is configured', async () => {
    // The normal state in dev and CI. Absent address must switch the feature off, not fail.
    const send = spySend();
    dbReturningCount(1);
    await alertOnCriticalError(entry());
    expect(send).not.toHaveBeenCalled();
  });

  it('never sends for a non-critical entry', async () => {
    vi.stubEnv('ALERT_EMAIL', 'owner@example.com');
    dbReturningCount(1);
    const send = spySend();
    for (const severity of ['error', 'warning', undefined]) {
      await alertOnCriticalError(entry({ severity }));
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('sends once per route per cooldown, not once per failing buyer', async () => {
    // The storm case, and the reason this module exists in the shape it does. A count above one
    // means an earlier critical on this route is already inside the window — somebody has been told.
    vi.stubEnv('ALERT_EMAIL', 'owner@example.com');
    dbReturningCount(37);
    const send = spySend();

    await alertOnCriticalError(entry());

    expect(send).not.toHaveBeenCalled();
  });

  it('still alerts for a DIFFERENT route inside the same window', async () => {
    // A blanket cooldown would swallow this, and it is a genuinely new fact: checkout failing and
    // then the payment webhook failing is two problems, not one repeated.
    vi.stubEnv('ALERT_EMAIL', 'owner@example.com');
    dbReturningCount(1); // the query is per-route, so a fresh route answers 1
    const send = spySend();

    await alertOnCriticalError(entry({ route: '/api/payment/confirm' }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].subject).toContain('/api/payment/confirm');
  });

  it('suppresses rather than mails when the dedup query fails', async () => {
    // When the database is unwell the wrong direction to fail is the one that sends mail: an
    // unreachable database is the case that produces failures on EVERY route at once.
    vi.stubEnv('ALERT_EMAIL', 'owner@example.com');
    dbThatFails();
    const send = spySend();

    await alertOnCriticalError(entry());

    expect(send).not.toHaveBeenCalled();
  });

  it('stops at the hourly ceiling however the failures are spread across routes', async () => {
    // The per-route window is keyed on something a bad loop can vary — a path with an id in it, or
    // a burst walking many routes. This is the layer that bounds the whole channel regardless.
    vi.stubEnv('ALERT_EMAIL', 'owner@example.com');
    dbReturningCount(1); // every route looks fresh
    const send = spySend();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let i = 0; i < MAX_ALERTS_PER_HOUR + 15; i++) {
      await alertOnCriticalError(entry({ route: `/api/checkout/${i}` }));
    }

    expect(send).toHaveBeenCalledTimes(MAX_ALERTS_PER_HOUR);
  });

  it('says on stderr what it suppressed, so a silenced alert is not an invisible one', async () => {
    vi.stubEnv('ALERT_EMAIL', 'owner@example.com');
    dbReturningCount(1);
    spySend();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let i = 0; i < MAX_ALERTS_PER_HOUR + 1; i++) {
      await alertOnCriticalError(entry({ route: `/api/checkout/${i}` }));
    }

    expect(stderr).toHaveBeenCalledWith(
      '[critical-alert] suppressed (hourly ceiling):',
      expect.any(String),
      expect.any(String),
    );
  });

  it('never throws, whatever the mailer does', async () => {
    // It runs inside logError, which runs inside the error handler. A throw here would replace the
    // failure being reported with a failure to report it.
    vi.stubEnv('ALERT_EMAIL', 'owner@example.com');
    dbReturningCount(1);
    vi.spyOn(email, 'sendEmail').mockRejectedValue(new Error('smtp exploded'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(alertOnCriticalError(entry())).resolves.toBeUndefined();
  });

  it('renders a readable mail without the optional fields', async () => {
    // storeName/actorLabel/statusCode are absent for an anonymous visitor on a route with no store
    // in its path. The mail must not print "undefined" at anybody.
    vi.stubEnv('ALERT_EMAIL', 'owner@example.com');
    dbReturningCount(1);
    const send = spySend();

    await alertOnCriticalError({ severity: 'critical', createdAt: '2026-08-05T10:00:00.000Z' });

    const message = send.mock.calls[0]![0];
    expect(message.html).not.toContain('undefined');
    expect(message.text).not.toContain('undefined');
    expect(message.subject).not.toContain('undefined');
    // And the time must be a time, not "Invalid Date" — the field is not on the row being written,
    // so it is passed in explicitly.
    expect(message.html).not.toContain('Invalid Date');
  });
});

describe('the subject line is a header, not a body', () => {
  it('cannot be made to carry a header break', async () => {
    // Defence in depth. A route reaches here only from middleware, where it is a parsed
    // URL.pathname and cannot hold a control character — and the one route field an outsider
    // supplies arrives as source:'client', which is always a warning and never alerts. That is two
    // accidents away, and both live in other files that someone could revisit without reading this
    // one. `esc()` would be the wrong tool: this is a header, so the worry is CR/LF, not `<`.
    vi.stubEnv('ALERT_EMAIL', 'owner@example.com');
    dbReturningCount(1);
    const send = spySend();

    await alertOnCriticalError(entry({ route: '/api/checkout\r\nBcc: attacker@evil.example' }));

    const subject = send.mock.calls[0]![0].subject;
    expect(subject).not.toContain('\r');
    expect(subject).not.toContain('\n');
    expect(subject.length).toBeLessThanOrEqual(200);
    // The route is still readable — sanitising must not turn the one useful word into noise.
    expect(subject).toContain('/api/checkout');
  });
});
