/**
 * The route that turns the image-filter alarm OFF, and the reason it is the one of the pair that
 * needs a login.
 *
 * Its twin, `/api/log-client-error`, is deliberately unauthenticated: reporting a FAULT can only
 * ever raise a false alarm, which is the safe direction to be wrong in. This one resolves an alarm
 * that already exists, so an anonymous visitor must not reach it — the only place an upload happens
 * is the seller's own dashboard, so a seller session turns nothing legitimate away.
 *
 * Everything below is about that gate and about the blast radius past it: what a caller can close
 * (reports that exist now) and what no caller can touch (the rule, and anything outside the window).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import type { APIContext, AstroCookies } from 'astro';
import { query, firstRow } from '../src/lib/db.js';
import { POST } from '../src/pages/api/seller/moderation-ok.js';
import { setSellerSession } from '../src/lib/seller-auth.js';
import { MODERATION_MISSING_MARKER } from '../src/lib/image-moderation.js';
import { MODERATION_AUTO_RESOLVE_HINT, MODERATION_STALE_DAYS } from '../src/lib/image-moderation-health.js';

const original = process.env.PUBLIC_IMAGE_MODERATION_ON;

/** A real signed session cookie, produced by the code that issues them — a hand-written token would
 *  prove the test can forge one, not that the route accepts a real one. */
function cookiesFor(sellerId: string | null): AstroCookies {
  let value: string | undefined;
  if (sellerId) {
    setSellerSession({ set: (_n: string, v: string) => { value = v; } } as unknown as AstroCookies, sellerId);
  }
  return { get: () => (value ? { value } : undefined) } as unknown as AstroCookies;
}

const ctx = (sellerId: string | null): APIContext => ({
  request: new Request('https://example.test/api/seller/moderation-ok', { method: 'POST' }),
  cookies: cookiesFor(sellerId),
} as unknown as APIContext);

async function makeSeller(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO sellers (id, name, email, password_hash, business_type, created_at)
     VALUES ($1, 'Moderation Route Test', $2, '', 'licensed', now())`,
    [id, `mod-${id}@example.test`],
  );
  return id;
}

async function logMissing(daysAgo = 1): Promise<void> {
  await query(
    `INSERT INTO error_log (id, source, message, created_at)
     VALUES (gen_random_uuid(), 'client', $1, now() - make_interval(days => $2))`,
    [`${MODERATION_MISSING_MARKER} the upload came back with no moderation verdict`, daysAgo],
  );
}

async function openReports(): Promise<number> {
  const row = await firstRow<{ n: string | number }>(
    'SELECT count(*) AS n FROM error_log WHERE message LIKE $1 AND NOT resolved',
    [`${MODERATION_MISSING_MARKER}%`],
  );
  return Number(row?.n ?? 0);
}

beforeEach(async () => {
  await query('DELETE FROM error_log');
  process.env.PUBLIC_IMAGE_MODERATION_ON = 'true';
});

afterEach(() => {
  if (original === undefined) delete process.env.PUBLIC_IMAGE_MODERATION_ON;
  else process.env.PUBLIC_IMAGE_MODERATION_ON = original;
});

describe('who may close the alarm', () => {
  it('refuses an anonymous caller and leaves the report standing', async () => {
    await logMissing();
    const res = await POST(ctx(null));
    expect(res.status).toBe(401);
    // The assertion that matters more than the status: nothing was written.
    expect(await openReports()).toBe(1);
  });

  it('accepts a logged-in seller and closes the outstanding reports', async () => {
    await logMissing();
    await logMissing(3);
    const sellerId = await makeSeller();
    const res = await POST(ctx(sellerId));
    expect(res.status).toBe(204);
    expect(await openReports()).toBe(0);
  });

  it('records WHY it closed, so an automatic dismissal is audited and not merely silent', async () => {
    /**
     * The one limit that cannot be closed from our side: the server never sees the upload, so
     * "an upload came back judged" can only come from the browser, and a browser can lie. A seller
     * could keep calling this while the filter is genuinely off. `resolution_hint` is what keeps
     * that visible — the Alerts tab renders it, so a report closed by an upload reads differently
     * from one a person closed, and a suppressed warning leaves a trail.
     */
    await logMissing();
    await POST(ctx(await makeSeller()));
    const row = await firstRow<{ resolution_hint: string | null }>(
      'SELECT resolution_hint FROM error_log WHERE message LIKE $1',
      [`${MODERATION_MISSING_MARKER}%`],
    );
    expect(row?.resolution_hint).toBe(MODERATION_AUTO_RESOLVE_HINT);
  });

  it('answers 204 and writes nothing while no add-on is declared', async () => {
    // Nothing was declared, so there is no alarm of this kind and no reason to touch the log — the
    // check is before the session lookup, so it also costs no query.
    process.env.PUBLIC_IMAGE_MODERATION_ON = 'false';
    await logMissing();
    const res = await POST(ctx(null));
    expect(res.status).toBe(204);
    expect(await openReports()).toBe(1);
  });
});

describe('what it cannot do', () => {
  it('touches only the moderation reports, never another alert', async () => {
    await logMissing();
    await query(
      `INSERT INTO error_log (id, source, message) VALUES (gen_random_uuid(), 'server', $1)`,
      ['TypeError: something else broke'],
    );
    await POST(ctx(await makeSeller()));
    const other = await firstRow<{ resolved: boolean }>(
      'SELECT resolved FROM error_log WHERE message LIKE $1', ['TypeError%'],
    );
    expect(other?.resolved).toBe(false);
  });

  it('leaves reports older than the window alone', async () => {
    // They are already outside what the card reads, and rewriting history it does not look at would
    // only make the log a worse record of when the condition started.
    await logMissing(MODERATION_STALE_DAYS + 5);
    await POST(ctx(await makeSeller()));
    expect(await openReports()).toBe(1);
  });

  it('cannot pre-emptively silence a condition that has not happened yet', async () => {
    // The whole safety argument in one case: it resolves rows, never a rule. A caller who closes
    // everything and then breaks the filter gets the card straight back.
    const sellerId = await makeSeller();
    await POST(ctx(sellerId));
    await logMissing(0);
    expect(await openReports()).toBe(1);
  });
});
