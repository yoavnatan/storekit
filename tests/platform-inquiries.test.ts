import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/lib/db.js';

/**
 * A person writing to the platform — the storage rules (`lib/platform-inquiries.ts`) and the
 * endpoint in front of them (`/api/report`).
 *
 * **This is `tests/user-reports.test.ts` carried forward across the inbox merge (2026-08-19), and
 * that is deliberate: every rule it held still holds.** What changed is where an inquiry lands — a
 * thread in the Messages inbox that can be answered, instead of a one-way row on the alerts tab.
 * What did not change is the rule that makes the record worth having, and it is the reason this
 * file exists: **the sender describes, the SERVER attributes.** A sender who could name the store
 * they are reporting, or their own role, would be able to point the admin at a competitor.
 *
 * Against a real Postgres and the real route, like the other endpoint suites here: what is being
 * asserted is what the ROUTE decides, and a mocked module would assert the mock.
 */

const SELLER_WITH_STORE = '11111111-1111-4111-8111-000000000001';

let session: string | null = null;

vi.mock('../src/lib/seller-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/seller-auth.js')>()),
  getSellerSession: () => session,
  getSellerById: async (id: string) => (id ? { id, name: 'מדווח', email: `${id}@x.test` } : null),
}));

const { POST } = await import('../src/pages/api/report.js');
const { getAdminThreadsPage } = await import('../src/lib/admin-messages.js');

const cookies = { get: () => undefined } as never;

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST({
    request: new Request('https://x.test/api/report', { method: 'POST', body: JSON.stringify(body), headers }),
    cookies,
    clientAddress: '203.0.113.7',
  } as never) as Promise<Response>;
}

/** The inbox as the admin's Messages tab reads it. Roots only, which is what an inquiry is. */
const inbox = async () =>
  (await getAdminThreadsPage({ sortCol: 'recent', unreadOnly: false, role: 'all', status: 'all' }, 1, 100)).threads;

beforeEach(async () => {
  await query('DELETE FROM admin_messages');
  await query('DELETE FROM auth_attempts');
  session = null;
});

describe('what a sender may and may not put in the record', () => {
  it('stores what they wrote, as a thread the platform can answer', async () => {
    const res = await post({ kind: 'content', message: 'תמונה לא ראויה במוצר', email: 'a@b.test' });
    expect(res.status).toBe(200);

    const [thread] = await inbox();
    expect(thread!.root.aboutKind).toBe('content');
    expect(thread!.root.content).toBe('תמונה לא ראויה במוצר');
    expect(thread!.root.partyEmail).toBe('a@b.test');
    expect(thread!.status).toBe('open');
    // Unread for the admin from the moment it is written — that is what the tab badge counts.
    expect(thread!.unreadForAdmin).toBe(1);
  });

  it('refuses an empty message rather than filing a blank thread', async () => {
    expect((await post({ kind: 'fault', message: '   ' })).status).toBe(400);
    expect((await post({ kind: 'fault' })).status).toBe(400);
    expect(await inbox()).toHaveLength(0);
  });

  it('will not let the body choose the sender role', async () => {
    // The point of the whole module: 'seller' is a claim about identity, and a claim a request
    // makes about itself is not one. A signed-out sender is a guest no matter what they send.
    await post({ kind: 'fault', message: 'משהו נשבר', reporterRole: 'seller', reporterId: SELLER_WITH_STORE } as never);
    const [thread] = await inbox();
    expect(thread!.partyRole).toBe('guest');
    expect(thread!.root.partyId).toBeUndefined();
    // And it must not become a thread some seller can read out of their own dashboard.
    expect(thread!.sellerId).toBe('');
  });

  it('will not let the body choose the store either', async () => {
    await post({ kind: 'store', message: 'החנות מטעה', storeSlug: 'a-competitor' } as never);
    const [thread] = await inbox();
    // Unresolvable from an unknown path = no store, never the one that was asserted.
    expect(thread!.root.storeSlug).toBeUndefined();
  });

  it('keeps only a site-relative page, never an off-site one', async () => {
    // `page_url` is rendered as a LINK in the admin panel, so an absolute URL here would make this
    // a way to put someone else's address in front of the admin — the same class
    // `safe-redirect.ts` exists for.
    await post({ kind: 'fault', message: 'א', pageUrl: 'https://evil.example/x' });
    await post({ kind: 'fault', message: 'ב', pageUrl: '//evil.example/x' });
    await post({ kind: 'fault', message: 'ג', pageUrl: '/checkout?step=2' });

    const byMessage = new Map((await inbox()).map((t) => [t.root.content, t.root.pageUrl]));
    expect(byMessage.get('א')).toBeUndefined();
    expect(byMessage.get('ב')).toBeUndefined();
    expect(byMessage.get('ג')).toBe('/checkout?step=2');
  });

  it('falls back to "other" for a kind the column would reject', async () => {
    // The CHECK constraint would raise on an unknown kind, and a raise here means an inquiry a
    // person wrote is simply lost.
    expect((await post({ kind: 'urgent!!', message: 'משהו' })).status).toBe(200);
    expect((await inbox())[0]!.root.aboutKind).toBe('other');
  });

  it('drops an unusable reply address but keeps the inquiry', async () => {
    // The message is the valuable half. Refusing it over a malformed address would throw away what
    // someone took the trouble to write, and storing the address anyway would leave the admin panel
    // offering a mailto that bounces.
    expect((await post({ kind: 'fault', message: 'לא נטען', email: 'not-an-address' })).status).toBe(200);
    const [thread] = await inbox();
    expect(thread!.root.content).toBe('לא נטען');
    expect(thread!.root.partyEmail).toBeUndefined();
  });

  it('caps the message instead of refusing a long one', async () => {
    await post({ kind: 'other', message: 'א'.repeat(5000) });
    expect((await inbox())[0]!.root.content.length).toBe(2000);
  });

  it('gives each kind a subject, so the inbox says which one it is', async () => {
    // Nothing asks the sender for a subject — a fourth field before saying the thing. Without one
    // every inquiry would render as "הודעת מערכת" and the list would say nothing at all.
    await post({ kind: 'fault', message: 'א' });
    expect((await inbox())[0]!.subject).toBe('דיווח על תקלה');
  });
});

describe('the rate limit in front of an unauthenticated write path', () => {
  it('lets ten inquiries through from one address and then asks for a wait', async () => {
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
    expect(await inbox()).toHaveLength(10);
  });
});
