/**
 * The invoices PayMe issue in a seller's name, landing on his orders.
 *
 * The defect this closes is a seller PAYING for something invisible: he switches the service on,
 * is billed ₪15 a month plus ₪0.3 a document, and his order cards go on asking him to upload the
 * invoice he is paying to have issued. So most of these assert the mapping, and two assert the
 * refusals — because the URL comes from a third party's JSON and is rendered as a link a buyer
 * clicks.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isProcessorDocumentUrl } from '../src/lib/invoicing/buyer-invoice.js';

const state = vi.hoisted(() => ({ orders: [] as { id: string }[], marked: [] as any[], markResult: {} as any }));

vi.mock('../src/lib/db.js', () => ({ rows: async () => state.orders }));
vi.mock('../src/lib/invoicing/buyer-invoice.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  markBuyerInvoiceProvided: async (sellerId: string, orderId: string, input: unknown) => {
    state.marked.push({ sellerId, orderId, input });
    return state.markResult;
  },
}));
vi.mock('../src/lib/error-log.js', () => ({ logError: async () => {} }));

const { attachInvoices } = await import('../src/lib/payme-invoice-sync.js');

const tx = (over: Record<string, unknown> = {}) => ({
  saleId: 'SALE-1', at: '2026-08-25 10:00:00', description: '', priceAgorot: 6000, netAgorot: 5020,
  processingAgorot: 150, marketFeeAgorot: 720, saleStatus: 'completed',
  invoiceUrl: 'https://live.payme.io/invoice/abc.pdf', ...over,
}) as any;

beforeEach(() => {
  state.orders = [{ id: 'ORD-1' }];
  state.marked = [];
  state.markResult = { orderId: 'ORD-1', status: 'issued', mode: 'processor', documentUrl: 'x', providedAt: null };
});

describe('isProcessorDocumentUrl', () => {
  it('accepts their host and its subdomains', () => {
    for (const url of ['https://payme.io/i/1.pdf', 'https://live.payme.io/i/1.pdf', 'https://hf.payme.io/i/1.pdf']) {
      expect(isProcessorDocumentUrl(url), url).toBe(true);
    }
  });

  /** The classic version of this mistake is a bare `endsWith('payme.io')`, which accepts a domain
   *  somebody else can register. The dot is what makes the suffix a boundary. */
  it('refuses a lookalike domain, plain http, and anything unparseable', () => {
    for (const url of ['https://evilpayme.io/i.pdf', 'http://payme.io/i.pdf', 'https://res.cloudinary.com/x/raw/upload/i.pdf', 'not a url', '']) {
      expect(isProcessorDocumentUrl(url), url).toBe(false);
    }
  });
});

describe('attachInvoices', () => {
  it('settles the order the charge belongs to, as the PROCESSOR mode', async () => {
    expect(await attachInvoices('SELLER-1', [tx()])).toBe(1);
    expect(state.marked).toHaveLength(1);
    expect(state.marked[0]).toMatchObject({
      sellerId: 'SELLER-1', orderId: 'ORD-1',
      input: { mode: 'processor', documentUrl: 'https://live.payme.io/invoice/abc.pdf' },
    });
  });

  /** The ordinary case, by a wide margin: the service is off for almost every seller, so almost
   *  every row has no document. It must cost no query at all. */
  it('skips a charge with no document without touching the database', async () => {
    expect(await attachInvoices('SELLER-1', [tx({ invoiceUrl: null })])).toBe(0);
    expect(state.marked).toHaveLength(0);
  });

  it('skips a charge with no sale id', async () => {
    expect(await attachInvoices('SELLER-1', [tx({ saleId: '' })])).toBe(0);
    expect(state.marked).toHaveLength(0);
  });

  /** The delivery leg is a charge on OUR merchant account for the whole cart and belongs to no
   *  order row; the shared sandbox can also hand back a partner's sale. Neither is an error. */
  it('is quiet about a charge it cannot place against an order', async () => {
    state.orders = [];
    expect(await attachInvoices('SELLER-1', [tx()])).toBe(0);
    expect(state.marked).toHaveLength(0);
  });

  /** `markBuyerInvoiceProvided` answers null when the URL fails its host check — so a bad link is
   *  counted as NOT attached rather than reported as a success. */
  it('does not count a settlement the write refused', async () => {
    state.markResult = null;
    expect(await attachInvoices('SELLER-1', [tx()])).toBe(0);
  });

  it('counts each charge once across a page of them', async () => {
    expect(await attachInvoices('SELLER-1', [tx(), tx({ saleId: 'SALE-2' }), tx({ invoiceUrl: null })])).toBe(2);
  });
});
