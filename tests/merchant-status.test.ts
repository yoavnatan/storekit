/**
 * The feed-approval monitor — `merchant-status*.ts` and the `merchant-status` job.
 *
 * **What this file is really pinning.** The monitor exists because Google and Meta reject rows
 * silently, so the one outcome it must never produce is a clean bill of health it did not actually
 * read. Every "unrecognised answer" case below is that property: a 200 whose body we cannot parse
 * has to come back as *no answer* (loud) and never as *no rejected items* (silent). If that ever
 * flips, the monitor becomes a second copy of the failure it was built to end — reassuring, wrong,
 * and permanent, because its symptom is the absence of alerts.
 *
 * The second property is the one the registry demands of every job: running it twice must leave the
 * same state as running it once. Here that means a seller is told about a rejection exactly once
 * while it persists, not once per tick.
 *
 * The two provider adapters are the only part that cannot be tested against reality until the
 * accounts exist, so what is asserted is our side of the boundary: how their documented shapes are
 * read, and what happens when the shape is not what we expected.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { adItemId, adComboItemId, productIdFromAdItemId } from '../src/lib/ad-item-id.js';
import { parseServiceAccountKey } from '../src/lib/google-auth.js';
import { offerIdFromGoogleProductId } from '../src/lib/merchant-status-google.js';
import { rejectionCeiling } from '../src/lib/merchant-status-check.js';
import type { MerchantStatusProvider, MerchantStatusReport } from '../src/lib/merchant-status.js';

const net = vi.hoisted(() => ({ responses: [] as { ok: boolean; body: unknown }[], calls: 0, bodies: [] as unknown[] }));

vi.mock('../src/lib/outbound-fetch.js', () => ({
  outboundFetch: async (_url: unknown, options?: { body?: unknown }) => {
    net.calls += 1;
    net.bodies.push(options?.body);
    const next = net.responses.shift() ?? { ok: true, body: {} };
    return { ok: next.ok, status: next.ok ? 200 : 500, json: async () => next.body } as Response;
  },
}));

const providers = vi.hoisted(() => ({ list: [] as MerchantStatusProvider[] }));

vi.mock('../src/lib/merchant-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/merchant-status.js')>()),
  getMerchantStatusProviders: () => providers.list,
}));

const { createGoogleMerchantProvider } = await import('../src/lib/merchant-status-google.js');
const { createMetaCatalogProvider } = await import('../src/lib/merchant-status-meta.js');
const { runMerchantStatusCheck } = await import('../src/lib/merchant-status-check.js');
const { resetGoogleTokenCache, getGoogleAccessToken } = await import('../src/lib/google-auth.js');

beforeEach(() => {
  net.responses = [];
  net.calls = 0;
  net.bodies = [];
  providers.list = [];
  resetGoogleTokenCache();
});

// ---------------------------------------------------------------------------
// The id, read backwards

describe('productIdFromAdItemId', () => {
  const PRODUCT = '11111111-1111-4111-8111-000000000001';

  it('recovers the product from both spellings the feed emits', () => {
    expect(productIdFromAdItemId(adItemId(PRODUCT))).toBe(PRODUCT);
    expect(productIdFromAdItemId(adItemId(PRODUCT, { צבע: 'אדום' }))).toBe(PRODUCT);
  });

  it('recovers it from the HASHED form too — the one a long Hebrew combo produces', () => {
    // The readable form of this combo blows Google's 50-char cap, so the id carries an opaque
    // 12-char token instead. A reverse map that only understood the readable form would silently
    // fail on exactly the variant-heavy products that are hardest to notice.
    const long = adComboItemId(PRODUCT, 'צבע=כחול כהה מאוד,מידה=ארבעים ושתיים,חומר=כותנה');
    expect(long.length).toBeLessThanOrEqual(50);
    expect(productIdFromAdItemId(long)).toBe(PRODUCT);
  });

  it('refuses anything that is not one of our ids rather than guessing', () => {
    expect(productIdFromAdItemId('')).toBeNull();
    expect(productIdFromAdItemId('sku-1234')).toBeNull();
    expect(productIdFromAdItemId('אגרטל-כחול')).toBeNull();
    // A uuid with something glued straight on is NOT the combo form — that needs a separator.
    expect(productIdFromAdItemId(`${PRODUCT}x`)).toBeNull();
    // ...and a trailing separator with no combo is not one of ours either.
    expect(productIdFromAdItemId(`${PRODUCT}-`)).toBeNull();
  });
});

describe('offerIdFromGoogleProductId', () => {
  it('takes the offer id out of Google\'s composite REST id', () => {
    expect(offerIdFromGoogleProductId('online:he:IL:abc-123')).toBe('abc-123');
  });

  it('splits from the right, so a colon inside a Hebrew variant value survives', () => {
    // ad-item-id.ts preserves Unicode option values verbatim, colon included. Splitting from the
    // left would truncate the id and turn a real rejection into an unmapped one.
    expect(offerIdFromGoogleProductId('online:he:IL:uuid-צבע-כחול:כהה')).toBe('uuid-צבע-כחול:כהה');
  });

  it('passes through an id that carries no prefix at all', () => {
    expect(offerIdFromGoogleProductId('bare-id')).toBe('bare-id');
  });
});

// ---------------------------------------------------------------------------
// "No answer" must never read as "no problems"

describe('a provider that cannot reach an answer', () => {
  const KEY = JSON.stringify({ client_email: 'svc@example.iam.gserviceaccount.com', private_key: pem() });

  it('returns null when Google answers 200 with a body we do not recognise', async () => {
    net.responses = [{ ok: true, body: { access_token: 'tok', expires_in: 3600 } }, { ok: true, body: { unexpected: true } }];
    const report = await createGoogleMerchantProvider('123', KEY).fetchStatuses();
    // Not `{items: []}`. An empty item list is a claim about the catalogue; this is the absence of
    // a claim, and only one of the two is safe to be wrong about.
    expect(report).toBeNull();
  });

  it('returns null when Meta answers 200 without the array', async () => {
    net.responses = [{ ok: true, body: { error: { message: 'Unknown field' } } }];
    expect(await createMetaCatalogProvider('cat', 'tok').fetchStatuses()).toBeNull();
  });

  it('returns null when the service-account key is not usable, without a network call', async () => {
    expect(parseServiceAccountKey('{"client_email":"a@b"}')).toBeNull();
    expect(await createGoogleMerchantProvider('123', 'not json').fetchStatuses()).toBeNull();
    expect(net.calls).toBe(0);
  });

  it('reports a rejected feed on its own, not as a healthy item list', async () => {
    net.responses = [
      { ok: true, body: { access_token: 'tok', expires_in: 3600 } },
      { ok: true, body: { kind: 'content#datafeedstatusesListResponse', resources: [{ processingStatus: 'failure', errors: [{ message: 'Invalid XML character', count: 4000 }] }] } },
    ];
    const report = await createGoogleMerchantProvider('123', KEY).fetchStatuses();
    expect(report?.feedError).toContain('Invalid XML character');
    // It stopped there: item statuses after a failed ingest describe the LAST good one.
    expect(report?.items).toHaveLength(0);
  });

  it('reads a normal Google page into item verdicts', async () => {
    net.responses = [
      { ok: true, body: { access_token: 'tok', expires_in: 3600 } },
      { ok: true, body: { kind: 'content#datafeedstatusesListResponse', resources: [{ processingStatus: 'success' }] } },
      { ok: true, body: {
        kind: 'content#productstatusesListResponse',
        resources: [
          { productId: 'online:he:IL:a', itemLevelIssues: [{ code: 'image_link_broken', servability: 'disapproved', description: 'Image unreachable' }] },
          { productId: 'online:he:IL:b', itemLevelIssues: [{ code: 'title_too_long', servability: 'demoted' }] },
        ],
      } },
    ];
    const report = await createGoogleMerchantProvider('123', KEY).fetchStatuses();
    expect(report?.items).toEqual([
      { itemId: 'a', approved: false, issueCode: 'image_link_broken', issue: 'Image unreachable' },
      // 'demoted' still serves. Paging a seller about a ranking nudge is how a channel gets muted.
      { itemId: 'b', approved: true, issueCode: 'title_too_long' },
    ]);
  });

  it('treats a Meta item under review as serving, not as rejected', async () => {
    net.responses = [{ ok: true, body: { data: [
      { retailer_id: 'a', review_status: 'pending' },
      { retailer_id: 'b', review_status: 'rejected', errors: [{ type: 'policy', title: 'Prohibited content' }] },
    ] } }];
    const report = await createMetaCatalogProvider('cat', 'tok').fetchStatuses();
    expect(report?.items[0]).toMatchObject({ itemId: 'a', approved: true });
    expect(report?.items[1]).toMatchObject({ itemId: 'b', approved: false, issue: 'Prohibited content' });
  });
});

// ---------------------------------------------------------------------------
// The Google assertion is really RS256 over really those bytes

describe('the service-account assertion', () => {
  it('signs what it actually SENDS, verifiably, with the account key', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const email = 'svc@example.iam.gserviceaccount.com';
    const key = { client_email: email, private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };

    net.responses = [{ ok: true, body: { access_token: 'tok', expires_in: 3600 } }];
    expect(await getGoogleAccessToken(key)).toBe('tok');

    // Taken off the wire rather than from a helper: what has to be right is the bytes Google
    // receives. A correct builder that something else fails to send is still a broken integration.
    const sent = new URLSearchParams(String(net.bodies[0]));
    expect(sent.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = String(sent.get('assertion')).split('.');

    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const parsed = JSON.parse(Buffer.from(claims!, 'base64url').toString());
    expect(parsed).toMatchObject({ iss: email, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/content' });
    expect(parsed.exp).toBeGreaterThan(parsed.iat);

    const verified = crypto.createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The pass: who gets told, and who deliberately does not

function fakeProvider(report: MerchantStatusReport | null): MerchantStatusProvider {
  return { network: 'google', fetchStatuses: async () => report };
}

interface Fixture { sellerId: string; storeId: string; productIds: string[] }

async function storeWithProducts(count: number): Promise<Fixture> {
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  const suffix = crypto.randomBytes(4).toString('hex');
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'Ad store')`,
    [storeId, sellerId, `merchant-status-${suffix}`]);
  const productIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    productIds.push(id);
    await query(
      `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock)
       VALUES ($1, $2, $3, $4, 9900, 5)`,
      [id, storeId, `widget-${suffix}-${i}`, `אגרטל ${i}`],
    );
  }
  return { sellerId, storeId, productIds };
}

async function notificationsFor(sellerId: string): Promise<{ title: string; body: string }[]> {
  const { rows } = await query<{ title: string; body: string }>(
    `SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'feed_status'`, [sellerId]);
  return rows;
}

async function alertsFor(route: string): Promise<number> {
  const { rows } = await query<{ n: string }>('SELECT count(*) AS n FROM error_log WHERE route = $1', [route]);
  return Number(rows[0]!.n);
}

/** Enough approved filler that a handful of rejections stays under the ceiling. */
function filler(from: number, to: number) {
  return Array.from({ length: to - from }, (_, i) => ({ itemId: crypto.randomUUID(), approved: true }));
}

describe('the check pass', () => {
  it('says nothing at all when no network is configured', async () => {
    expect(await runMerchantStatusCheck()).toContain('not configured');
    // Not in dev or CI: inert is the correct and permanent state here, and a reminder that fires
    // where it does not apply is one nobody reads on the day it does.
    expect(await alertsFor('job:merchant-status:unconfigured')).toBe(0);
  });


  it('tells the seller once, and stays quiet on the next run while it is still broken', async () => {
    const { sellerId, productIds } = await storeWithProducts(1);
    const report: MerchantStatusReport = {
      network: 'google',
      items: [
        { itemId: adItemId(productIds[0]!), approved: false, issueCode: 'image_link_broken', issue: 'Image unreachable' },
        ...filler(0, 60),
      ],
    };
    providers.list = [fakeProvider(report)];

    const first = await runMerchantStatusCheck();
    expect(first).toContain('told 1');
    const told = await notificationsFor(sellerId);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain('אגרטל 0');
    expect(told[0]!.body).toContain('Image unreachable');

    // Same answer an hour later. The registry requires a second run to change nothing, and a
    // notification bell that repeats itself is one people stop reading.
    const second = await runMerchantStatusCheck();
    expect(second).toContain('told 0');
    expect(await notificationsFor(sellerId)).toHaveLength(1);
  });

  it('tells the seller once for a product whose variants were rejected together', async () => {
    const { sellerId, productIds } = await storeWithProducts(1);
    const product = productIds[0]!;
    providers.list = [fakeProvider({
      network: 'google',
      items: [
        { itemId: adComboItemId(product, 'צבע=אדום'), approved: false, issueCode: 'image_link_broken' },
        { itemId: adComboItemId(product, 'צבע=כחול'), approved: false, issueCode: 'image_link_broken' },
        ...filler(0, 60),
      ],
    })];

    // One product, one fix, one message — even though the feed emits a row per combo.
    expect(await runMerchantStatusCheck()).toContain('told 1');
    expect(await notificationsFor(sellerId)).toHaveLength(1);
  });

  it('holds every seller notification when the rejection rate says the fault is ours', async () => {
    const { sellerId, productIds } = await storeWithProducts(30);
    providers.list = [fakeProvider({
      network: 'google',
      items: productIds.map((id) => ({ itemId: adItemId(id), approved: false, issueCode: 'policy' })),
    })];

    const line = await runMerchantStatusCheck();

    expect(line).toContain('HELD');
    // Nobody was blamed. 30 sellers' worth of "you did something wrong" is not recoverable by a
    // correction an hour later, and a rate this high is our feed, our account or a policy change.
    expect(await notificationsFor(sellerId)).toHaveLength(0);
    expect(await alertsFor('job:merchant-status:google:mass-rejection')).toBe(1);
  });

  it('raises the join alarm when the ids match no product, even with nothing rejected', async () => {
    providers.list = [fakeProvider({
      network: 'google',
      items: Array.from({ length: 40 }, (_, i) => ({ itemId: `legacy-slug-${i}`, approved: true })),
    })];

    await runMerchantStatusCheck();

    // Everything "approved", nothing wrong on either side, and the two systems joined to nothing —
    // the exact shape that survived four months and five verification layers once already.
    expect(await alertsFor('job:merchant-status:google:unmapped-ids')).toBe(1);
  });

  it('alerts on an unreachable network, and separately on an empty catalogue', async () => {
    providers.list = [fakeProvider(null)];
    expect(await runMerchantStatusCheck()).toContain('no answer');
    expect(await alertsFor('job:merchant-status:google:unreachable')).toBe(1);

    providers.list = [fakeProvider({ network: 'google', items: [] })];
    expect(await runMerchantStatusCheck()).toContain('catalogue empty');
    expect(await alertsFor('job:merchant-status:google:empty')).toBe(1);
  });

  it('does not repeat a platform alert on every tick', async () => {
    providers.list = [fakeProvider(null)];
    await runMerchantStatusCheck();
    await runMerchantStatusCheck();
    await runMerchantStatusCheck();
    expect(await alertsFor('job:merchant-status:google:unreachable')).toBe(1);
  });
});

describe('what the pass refuses to be quiet about', () => {
  it('announces a partial read instead of reporting a clean catalogue it did not finish', async () => {
    providers.list = [fakeProvider({
      network: 'google',
      items: Array.from({ length: 40 }, () => ({ itemId: crypto.randomUUID(), approved: true })),
      truncated: true,
    })];

    const line = await runMerchantStatusCheck();

    // "checked 40, rejected 0" on a catalogue of 9,000 is a true sentence and a false impression.
    expect(line).toContain('PARTIAL');
    expect(await alertsFor('job:merchant-status:google:truncated')).toBe(1);
  });

  it('survives one network failing without losing the other one\'s pass', async () => {
    const exploding: MerchantStatusProvider = {
      network: 'meta',
      fetchStatuses: async () => { throw new Error('boom'); },
    };
    providers.list = [exploding, fakeProvider({ network: 'google', items: [{ itemId: crypto.randomUUID(), approved: true }] })];

    // A job never throws out of run() — and one bad network must not cost the other its answer.
    const line = await runMerchantStatusCheck();
    expect(line).toContain('meta: no answer');
    expect(line).toContain('google: checked 1');
  });

  it('clamps the free text an ad network sends before it reaches a seller', async () => {
    net.responses = [{ ok: true, body: { data: [
      { retailer_id: 'a', review_status: 'rejected', errors: [{ type: 'x'.repeat(500), title: 'y'.repeat(5000) }] },
    ] } }];
    const report = await createMetaCatalogProvider('cat', 'tok').fetchStatuses();

    // It lands in a notification body and a related_id, neither of which clamps anything. The length
    // of a third party's error string is not ours to assume — error-log.ts caps its own for the
    // same reason, and this is that rule applied on the way in.
    expect(report!.items[0]!.issue!.length).toBe(300);
    expect(report!.items[0]!.issueCode!.length).toBe(80);
  });
});

describe('rejectionCeiling', () => {
  it('is a floor while the platform is small and a share once it is not', () => {
    expect(rejectionCeiling(4)).toBe(20);
    expect(rejectionCeiling(1000)).toBe(250);
  });
});

/** A throwaway PKCS8 key, generated once per run — the adapter only has to reach `createSign`. */
function pem(): string {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}
