import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/lib/db.js';

/**
 * "דווח על תקלה" — the storage rules (`lib/user-reports.ts`) and the endpoint in front of them
 * (`/api/report`).
 *
 * Against a real Postgres and the real route, like the other endpoint suites here: what is being
 * asserted is what the ROUTE decides — that a report cannot name its own store or its own reporter,
 * and that an unauthenticated write path is bounded — and a mocked module would assert the mock.
 */

const SELLER_WITH_STORE = '11111111-1111-4111-8111-000000000001';

let session: string | null = null;

vi.mock('../src/lib/seller-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/seller-auth.js')>()),
  getSellerSession: () => session,
  getSellerById: async (id: string) => (id ? { id, name: 'מדווח', email: `${id}@x.test` } : null),
}));

const { POST } = await import('../src/pages/api/report.js');
const { createUserReport, getRecentReports, countOpenReports, setReportHandled } = await import('../src/lib/user-reports.js');

const cookies = { get: () => undefined } as never;

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST({
    request: new Request('https://x.test/api/report', { method: 'POST', body: JSON.stringify(body), headers }),
    cookies,
    clientAddress: '203.0.113.7',
  } as never) as Promise<Response>;
}

beforeEach(async () => {
  await query('DELETE FROM user_reports');
  await query('DELETE FROM auth_attempts');
  session = null;
});

describe('what a reporter may and may not put in the record', () => {
  it('stores what they wrote', async () => {
    const res = await post({ kind: 'content', message: 'תמונה לא ראויה במוצר', email: 'a@b.test' });
    expect(res.status).toBe(200);

    const [report] = await getRecentReports();
    expect(report.kind).toBe('content');
    expect(report.message).toBe('תמונה לא ראויה במוצר');
    expect(report.reporterEmail).toBe('a@b.test');
    expect(report.status).toBe('open');
  });

  it('refuses an empty message rather than filing a blank row', async () => {
    expect((await post({ kind: 'fault', message: '   ' })).status).toBe(400);
    expect((await post({ kind: 'fault' })).status).toBe(400);
    expect(await countOpenReports()).toBe(0);
  });

  it('will not let the body choose the reporter role', async () => {
    // The point of the whole module: 'seller' is a claim about identity, and a claim a request
    // makes about itself is not one. A signed-out sender is a guest no matter what they send.
    await post({ kind: 'fault', message: 'משהו נשבר', reporterRole: 'seller', reporterId: SELLER_WITH_STORE } as never);
    const [report] = await getRecentReports();
    expect(report.reporterRole).toBe('guest');
    expect(report.reporterId).toBeUndefined();
  });

  it('will not let the body choose the store either', async () => {
    await post({ kind: 'store', message: 'החנות מטעה', storeSlug: 'a-competitor' } as never);
    const [report] = await getRecentReports();
    // Unresolvable from an unknown path = no store, never the one that was asserted.
    expect(report.storeSlug).toBeUndefined();
  });

  it('keeps only a site-relative page, never an off-site one', async () => {
    // `page_url` is rendered as a LINK in the admin panel, so an absolute URL here would make this
    // table a way to put someone else's address in front of the admin — the same class
    // `safe-redirect.ts` exists for.
    await post({ kind: 'fault', message: 'א', pageUrl: 'https://evil.example/x' });
    await post({ kind: 'fault', message: 'ב', pageUrl: '//evil.example/x' });
    await post({ kind: 'fault', message: 'ג', pageUrl: '/checkout?step=2' });

    const byMessage = new Map((await getRecentReports()).map((r) => [r.message, r.pageUrl]));
    expect(byMessage.get('א')).toBeUndefined();
    expect(byMessage.get('ב')).toBeUndefined();
    expect(byMessage.get('ג')).toBe('/checkout?step=2');
  });

  it('falls back to "other" for a kind the column would reject', async () => {
    // The CHECK constraint would raise on an unknown kind, and a raise here means a report a person
    // wrote is simply lost.
    expect((await post({ kind: 'urgent!!', message: 'משהו' })).status).toBe(200);
    expect((await getRecentReports())[0].kind).toBe('other');
  });

  it('drops an unusable reply address but keeps the report', async () => {
    // The report is the valuable half. Refusing it over a malformed address would throw away what
    // someone took the trouble to write, and storing the address anyway would leave the admin panel
    // offering a mailto that bounces.
    expect((await post({ kind: 'fault', message: 'לא נטען', email: 'not-an-address' })).status).toBe(200);
    const [report] = await getRecentReports();
    expect(report.message).toBe('לא נטען');
    expect(report.reporterEmail).toBeUndefined();
  });

  it('caps the message instead of refusing a long one', async () => {
    await post({ kind: 'other', message: 'א'.repeat(5000) });
    expect((await getRecentReports())[0].message.length).toBe(2000);
  });
});

describe('the rate limit in front of an unauthenticated write path', () => {
  it('lets ten reports through from one address and then asks for a wait', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post({ kind: 'fault', message: `דיווח ${i}` })).status).toBe(200);
    }
    const refused = await post({ kind: 'fault', message: 'אחד יותר מדי' });
    expect(refused.status).toBe(429);
    const body = await refused.json() as { throttled?: boolean; retryAfterMinutes?: number };
    expect(body.throttled).toBe(true);
    // A number, not "later" — the person has something to say and is being asked to wait.
    expect(body.retryAfterMinutes).toBeGreaterThan(0);

    // And nothing extra was stored: the refusal happens before the insert.
    expect(await countOpenReports()).toBe(10);
  });
});

describe('admin triage', () => {
  it('marks one handled and back again', async () => {
    await createUserReport({
      kind: 'fault', message: 'לא נטען', reporterEmail: null, pageUrl: '/search',
      userAgent: 'test-agent', cookies,
    });
    const [report] = await getRecentReports();
    expect(await countOpenReports()).toBe(1);

    expect(await setReportHandled(report.id, true)).toBe(true);
    expect(await countOpenReports()).toBe(0);
    expect((await getRecentReports())[0].handledAt).toBeTruthy();

    expect(await setReportHandled(report.id, false)).toBe(true);
    expect(await countOpenReports()).toBe(1);
    expect((await getRecentReports())[0].handledAt).toBeUndefined();
  });

  it('answers false for an id that is not a report — including one that is not a uuid', async () => {
    // Not a style point: a non-uuid reaches Postgres as a cast error, i.e. a 500 on a request whose
    // honest answer is 404.
    expect(await setReportHandled('not-a-uuid', true)).toBe(false);
    expect(await setReportHandled('99999999-9999-4999-8999-999999999999', true)).toBe(false);
  });

  it('puts the still-open ones above the handled ones', async () => {
    for (const message of ['ראשון', 'שני', 'שלישי']) {
      await createUserReport({ kind: 'fault', message, reporterEmail: null, pageUrl: null, userAgent: null, cookies });
    }
    const target = (await getRecentReports()).find((r) => r.message === 'שני')!;
    await setReportHandled(target.id, true);

    const after = await getRecentReports();
    expect(after.map((r) => r.status)).toEqual(['open', 'open', 'handled']);
    expect(after[2].message).toBe('שני');
    // Picked BY MESSAGE, not by position, and the order among the two open ones is not asserted:
    // `created_at` defaults to the transaction clock, so three reports filed in one test can share
    // a timestamp. Asserting a position there is asserting the tiebreaker, not the rule.
  });

  it('returns the same order twice for rows that share a timestamp', async () => {
    // The fragility above, as a rule rather than as a flake: an admin working through a queue must
    // not have it reshuffle under them on refresh (`getRecentReports`'s `id` tiebreaker).
    for (const message of ['א', 'ב', 'ג', 'ד']) {
      await createUserReport({ kind: 'other', message, reporterEmail: null, pageUrl: null, userAgent: null, cookies });
    }
    const first = (await getRecentReports()).map((r) => r.id);
    const second = (await getRecentReports()).map((r) => r.id);
    expect(second).toEqual(first);
  });
});
