/**
 * The re-verification safety rules.
 *
 * The job behind these writes `custom_domain_status`, and that field decides whether a seller's
 * store is served from their own domain at all. A wrong answer here does not show up as a bad
 * number on a screen — it takes a working storefront off the internet, for every seller at once if
 * the wrong answer is systematic. So the two properties that keep it from doing that are pinned
 * here rather than left as a reading of the code:
 *
 *   1. a check that could not be MADE is not a check that FAILED;
 *   2. a failure that is too widespread to be true is treated as ours, not theirs.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const outbound = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/outbound-fetch.js', () => ({ outboundFetch: outbound }));

import { createStubProvider } from '../src/lib/custom-domain.js';
import { createCloudflareProvider } from '../src/lib/custom-domain-cloudflare.js';
import { demoteCeiling, DEMOTE_LIMIT } from '../src/lib/custom-domain-verify.js';

function cfResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

describe('an unreachable provider has no opinion', () => {
  // Braces, not a bare arrow: `beforeEach` treats a returned FUNCTION as a teardown callback, and
  // `mockReset()` returns the mock — so `() => outbound.mockReset()` hands vitest the mock itself
  // to call after every test, which runs whatever implementation that test installed. With a mock
  // that throws on purpose, the test fails at the throw site while the code under test was right.
  beforeEach(() => { outbound.mockReset(); });
  afterEach(() => { vi.unstubAllEnvs(); });   // braces for the same reason as above

  const cf = () => createCloudflareProvider('token', 'zone');

  it("reports 'unknown' when the API call throws", async () => {
    // A synchronous throw, not `mockRejectedValue`/an async throw: vitest keeps every mock result
    // in `mock.results`, and a stored rejected promise is reported as an unhandled rejection even
    // though the caller awaited it inside its own try. `findId` catches both identically.
    outbound.mockImplementation(() => { throw new Error('ECONNREFUSED'); });
    expect((await cf().checkStatus('shop.example')).status).toBe('unknown');
  });

  it("reports 'unknown' on a non-2xx — an expired token answers, it just doesn't answer THIS", async () => {
    outbound.mockResolvedValue(cfResponse({ errors: [{ message: 'Invalid API Token' }] }, false));
    expect((await cf().checkStatus('shop.example')).status).toBe('unknown');
  });

  it("reports 'pending' when the provider is reached and genuinely has no such hostname", async () => {
    // The distinction the whole three-member type exists for: this one IS an answer, and demoting
    // on it is correct.
    outbound.mockResolvedValue(cfResponse({ result: [] }));
    expect((await cf().checkStatus('shop.example')).status).toBe('pending');
  });

  it("reports 'pending' while the certificate is still issuing, not 'active'", async () => {
    outbound.mockResolvedValue(cfResponse({ result: [{ id: '1', status: 'active', ssl: { status: 'pending_validation' } }] }));
    expect((await cf().checkStatus('shop.example')).status).toBe('pending');
  });

  it("reports 'active' only when hostname AND certificate are both active", async () => {
    outbound.mockResolvedValue(cfResponse({ result: [{ id: '1', status: 'active', ssl: { status: 'active' } }] }));
    expect((await cf().checkStatus('shop.example')).status).toBe('active');
  });

  it('the dev stub cannot demote anyone — no account, no opinion', async () => {
    // Every environment with no Cloudflare credentials runs this provider, production included if
    // the secrets ever go missing. If it answered 'pending' the hourly job would read a missing
    // env var as "every seller unpointed their DNS".
    expect((await createStubProvider().checkStatus('shop.example')).status).toBe('unknown');
    vi.stubEnv('CUSTOM_DOMAIN_DEV_AUTOVERIFY', '1');
    expect((await createStubProvider().checkStatus('shop.example')).status).toBe('active');
  });
});

describe('a demotion this widespread is our failure, not theirs', () => {
  it('holds at a floor of 3 while the platform is small', () => {
    expect(demoteCeiling(0)).toBe(DEMOTE_LIMIT);
    expect(demoteCeiling(4)).toBe(DEMOTE_LIMIT);
    expect(demoteCeiling(12)).toBe(DEMOTE_LIMIT);
  });

  it('becomes a share of the platform once the floor would be the wrong shape', () => {
    // With 200 live domains, three sellers changing DNS in one hour is ordinary — a fixed 3 would
    // hold the demotion forever and the job would stop doing its job.
    expect(demoteCeiling(40)).toBe(10);
    expect(demoteCeiling(200)).toBe(50);
  });

  it('never lets one pass demote everything, at any size', () => {
    for (const n of [1, 3, 10, 50, 200, 1000]) expect(demoteCeiling(n)).toBeLessThan(Math.max(n, 4));
  });
});
