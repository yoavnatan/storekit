/**
 * Hyp Pay adapter — the gateway's own rules, pinned.
 *
 * These are not "does the function run" tests. Every case here is a way a real Hyp integration
 * silently takes the wrong amount of money, or accepts a payment that never happened, and each
 * one is a rule that comes from Hyp's documentation rather than from our code:
 *
 *  · Amount is in SHEKELS and `inputObj.originalAmount` is in AGOROT — in the same request.
 *  · A J5 authorization answers 700, not 0. Code that only knows 0 rejects good payments.
 *  · The redirect arrives in the buyer's browser, so it is verified with Hyp, never trusted.
 *  · A capture may be for less than was authorized, never more.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const net = vi.hoisted(() => ({ replies: [] as string[], urls: [] as string[], ok: true }));

vi.mock('../src/lib/outbound-fetch.js', () => ({
  outboundFetch: async (url: string) => {
    net.urls.push(url);
    const body = net.replies.shift() ?? '';
    return { ok: net.ok, status: net.ok ? 200 : 500, text: async () => body } as Response;
  },
}));

const {
  shekels, parseHypResponse, maskCredentials, isPublicDemoTerminal,
  signPaymentPageRequest, verifyRedirect, fetchCardToken, captureAuthorization, cancelTransaction, splitTokef,
  HYP_AUTHORIZED, HYP_OK, HYP_NOT_CANCELLABLE,
} = await import('../src/lib/payment-hyp.js');

const CREDS = { masof: '0010131918', key: 'test-key', passp: 'test-pass', baseUrl: 'https://pay.hyp.co.il/p/' };

/** The last URL the adapter built, as parameters. */
function lastParams(): URLSearchParams {
  return new URL(net.urls[net.urls.length - 1]!).searchParams;
}

beforeEach(() => { net.replies = []; net.urls = []; net.ok = true; });

describe('amount units', () => {
  it('converts agorot to a shekel string without float drift', () => {
    expect(shekels(1015)).toBe('10.15');
    expect(shekels(1000)).toBe('10.00');
    expect(shekels(5)).toBe('0.05');
    expect(shekels(0)).toBe('0.00');
    // 1015/100 is 10.149999999999999 in binary floating point. Any implementation that divides
    // and stringifies fails exactly here, and would hand Hyp an amount with 15 decimal places.
    expect(shekels(1015)).not.toContain('999');
  });

  it('refuses a non-integer, because agorot are the unit and a fraction of one means a bug upstream', () => {
    expect(() => shekels(10.5)).toThrow(/integer agorot/);
  });

  it('uses money.ts\'s converter rather than a second copy of the rule', async () => {
    // The conversion is a money rule and money.ts owns every money rule. A local copy here is how
    // two gateways end up rounding differently — the exact class the module was built to close.
    const { agorotToDecimalString } = await import('../src/lib/money.js');
    expect(shekels).toBe(agorotToDecimalString);
  });

  it('sends SHEKELS in Amount and AGOROT in inputObj.originalAmount — in the same capture request', async () => {
    net.replies = ['Id=404274302&CCode=0&Amount=15&ACode=0463077'];
    await captureAuthorization({
      authCode: '0463077', originalUid: 'uid-1', token: 'tok', tokenExpiry: '0531',
      authorizedAgorot: 1500, captureAgorot: 1500, description: 'test',
    }, CREDS);
    const p = lastParams();
    expect(p.get('Amount')).toBe('15.00');
    expect(p.get('inputObj.originalAmount')).toBe('1500');
  });
});

describe('J5 authorization', () => {
  it('names 700 as the authorized code, distinct from the 0 every other call answers', () => {
    // Pinned deliberately: 700 looks like an error code, and "fixing" it to 0 would make every
    // successful authorization read as a decline.
    expect(HYP_AUTHORIZED).toBe('700');
    expect(HYP_OK).toBe('0');
    expect(HYP_AUTHORIZED).not.toBe(HYP_OK);
  });

  it('requests J5, MoreData and Sign — the three flags the rest of the flow depends on', async () => {
    net.replies = ['Amount=10.00&Masof=0010131918&action=pay&signature=abc123'];
    const { url } = await signPaymentPageRequest(
      { amountAgorot: 1000, orderRef: 'CHK-1', description: 'cart' }, CREDS);
    const sent = new URL(net.urls[0]!).searchParams;
    expect(sent.get('J5')).toBe('True');       // without it there is no hold, only a charge
    expect(sent.get('MoreData')).toBe('True'); // without it the redirect carries no UID — no capture
    expect(sent.get('Sign')).toBe('True');     // without it the redirect carries no signature — no verify
    expect(sent.get('Coin')).toBe('1');
    expect(sent.get('Amount')).toBe('10.00');
    expect(url).toContain('signature=abc123');
  });

  it('treats a signature-less answer as a failure even though Hyp returned HTTP 200', async () => {
    // Hyp refuses inside a 200 body. A caller that checks only res.ok would redirect the buyer to
    // a payment page URL that is really an error string.
    net.replies = ['CCode=902'];
    await expect(signPaymentPageRequest(
      { amountAgorot: 1000, orderRef: 'CHK-1', description: 'cart' }, CREDS)).rejects.toThrow(/no signature/);
  });
});

describe('verifying the redirect', () => {
  it('echoes every redirect parameter back in the order it arrived', async () => {
    net.replies = ['CCode=0'];
    const redirect: [string, string][] = [['Id', '408941655'], ['CCode', '700'], ['Amount', '10'], ['Sign', 'abcd']];
    expect(await verifyRedirect(redirect, CREDS)).toBe(true);
    const p = lastParams();
    expect(p.get('What')).toBe('VERIFY');
    // Hyp signs over the sequence, so the order is part of the payload, not a detail.
    expect([...p.keys()].slice(-4)).toEqual(['Id', 'CCode', 'Amount', 'Sign']);
  });

  it('returns false when Hyp does not recognise the signature', async () => {
    net.replies = ['CCode=901'];
    expect(await verifyRedirect([['Id', 'forged'], ['CCode', '0']], CREDS)).toBe(false);
  });
});

describe('token and capture', () => {
  it('reads the token and its expiry', async () => {
    net.replies = ['Id=401594866&CCode=0&Token=0505743578473060772&Tokef=3105'];
    expect(await fetchCardToken('401594866', CREDS)).toEqual({ token: '0505743578473060772', expiry: '3105' });
  });

  it('throws when the token call is refused, rather than capturing with an empty token', async () => {
    net.replies = ['CCode=447'];
    await expect(fetchCardToken('401594866', CREDS)).rejects.toThrow(/getToken failed/);
  });

  it('reads Tokef as YYMM, the way Hyp\'s own worked example does', () => {
    // Their example: getToken answers Tokef=3105, and the capture that works sends
    // Tmonth=05&Tyear=31. Splitting it the intuitive way round is a live CCode=416.
    expect(splitTokef('3105')).toEqual({ year: '31', month: '05' });
  });

  it('sends the month and year the capture expects, not the halves of Tokef in order', async () => {
    net.replies = ['Id=1&CCode=0'];
    await captureAuthorization({
      authCode: 'a', originalUid: 'u', token: 't', tokenExpiry: '3105',
      authorizedAgorot: 100, captureAgorot: 100, description: 'd',
    }, CREDS);
    const p = lastParams();
    expect(p.get('Tmonth')).toBe('05');
    expect(p.get('Tyear')).toBe('31');
  });

  it('captures for LESS than was authorized', async () => {
    net.replies = ['Id=1&CCode=0'];
    await captureAuthorization({
      authCode: 'a', originalUid: 'u', token: 't', tokenExpiry: '1229',
      authorizedAgorot: 5000, captureAgorot: 4200, description: 'd',
    }, CREDS);
    expect(lastParams().get('Amount')).toBe('42.00');
  });

  it('refuses to over-capture locally, without asking Hyp', async () => {
    // Hyp's answer to this depends on terminal configuration, so leaving it to them means the
    // same code takes 60₪ on one terminal and fails on another. Neither is acceptable on a
    // money path, so it never leaves the process.
    await expect(captureAuthorization({
      authCode: 'a', originalUid: 'u', token: 't', tokenExpiry: '1229',
      authorizedAgorot: 5000, captureAgorot: 5001, description: 'd',
    }, CREDS)).rejects.toThrow(/exceeds authorized/);
    expect(net.urls).toHaveLength(0);
  });

  it('uses Hyp\'s placeholder ID when the buyer never gave one', async () => {
    net.replies = ['Id=1&CCode=0'];
    await captureAuthorization({
      authCode: 'a', originalUid: 'u', token: 't', tokenExpiry: '1229',
      authorizedAgorot: 100, captureAgorot: 100, description: 'd',
    }, CREDS);
    expect(lastParams().get('UserId')).toBe('000000000');
  });

  it('throws on a refused capture instead of reporting a silent success', async () => {
    net.replies = ['CCode=033'];
    await expect(captureAuthorization({
      authCode: 'a', originalUid: 'u', token: 't', tokenExpiry: '1229',
      authorizedAgorot: 100, captureAgorot: 100, description: 'd',
    }, CREDS)).rejects.toThrow(/capture refused/);
  });
});

describe('cancelling a hold', () => {
  it('reports success', async () => {
    net.replies = ['TransId=405532558&CCode=0&ReversalStatus=777'];
    expect(await cancelTransaction('405532558', CREDS)).toEqual({ cancelled: true, code: '0' });
  });

  it('reports the closed window rather than pretending the hold was released', async () => {
    // 920 means the transaction was already transmitted: the money is real and the caller has to
    // refund. Returning `cancelled: true` here would leave a buyer charged for a cancelled order.
    net.replies = [`TransId=405532558&CCode=${HYP_NOT_CANCELLABLE}`];
    expect(await cancelTransaction('405532558', CREDS)).toEqual({ cancelled: false, code: '920' });
  });
});

describe('operational safety', () => {
  it('masks credentials that travel in the query string', () => {
    const url = 'https://pay.hyp.co.il/p/?action=soft&KEY=secret-key&PassP=secret-pass&Amount=10';
    const masked = maskCredentials(url);
    expect(masked).not.toContain('secret-key');
    expect(masked).not.toContain('secret-pass');
    expect(masked).toContain('Amount=10');
  });

  it('masks credentials in the error raised by a failed HTTP call', async () => {
    net.ok = false;
    net.replies = [''];
    await expect(fetchCardToken('1', CREDS)).rejects.toThrow(/PassP=\*\*\*/);
  });

  it('recognises the shared public demo terminal by identity, never by a prefix rule', () => {
    // Hyp's docs say test terminals start with 00100, and their own documented test terminals
    // (0010345518, 0010131918) do not. A prefix check would therefore misclassify terminals in
    // both directions, so the module states the one terminal it actually knows.
    expect(isPublicDemoTerminal('0010131918')).toBe(true);
    expect(isPublicDemoTerminal('0010345518')).toBe(false);
    expect(isPublicDemoTerminal('0882819014')).toBe(false);
  });
});

describe('response parsing', () => {
  it('parses the query-string body Hyp answers with, including empty fields', () => {
    expect(parseHypResponse('Id=401594866&CCode=0&Token=05057&Tokef=3105&Fild1=&Fild2=&Fild3='))
      .toEqual({ Id: '401594866', CCode: '0', Token: '05057', Tokef: '3105', Fild1: '', Fild2: '', Fild3: '' });
  });

  it('decodes percent-encoded values rather than handing back the raw text', () => {
    expect(parseHypResponse('Info=final%20charge&CCode=0').Info).toBe('final charge');
  });
});
