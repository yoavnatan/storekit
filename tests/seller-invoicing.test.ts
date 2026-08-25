/**
 * Which add-on the seller is offered, and — mostly — when he is offered nothing.
 *
 * The absence is the case worth pinning. PayMe provision a service onto a merchant and nothing we
 * can call creates one (sandbox notes §26), so on every account we have today there is no invoicing
 * service at all. If this ever returned a truthy offer for such an account, the dashboard would
 * show a seller a paid feature whose switch cannot be thrown — the class GO_LIVE §3.0.2 names for
 * the subscription refund: a promise that cannot be performed is worse than no promise.
 */
import { describe, expect, it } from 'vitest';
import { invoiceOffer } from '../src/lib/seller-invoicing.js';
import type { PaymeService } from '../src/lib/payment-payme.js';

const svc = (over: Partial<PaymeService>): PaymeService => ({
  id: 'VASL-1', type: 'Payments', description: 'חשבון סליקה',
  active: false, periodicAgorot: 0, usageAgorot: 0, period: 3, ...over,
});

/** The 19 services every one of our merchants really came back with, in shape: several `Payments`
 *  and `Settlements` rows, and 3DSecure sitting there switched OFF. No invoicing. */
const REAL_ACCOUNT: PaymeService[] = [
  svc({ id: 'a', type: 'Settlements', description: 'עמלת סליקה', active: true }),
  svc({ id: 'b', type: 'AlternativePaymentMethod', description: 'חשבון סליקה', active: true }),
  svc({ id: 'c', type: 'Payments', description: 'שירות 3DSecure', active: false }),
  svc({ id: 'd', type: 'Email', description: 'חשבון סליקה', active: true }),
];

describe('invoiceOffer', () => {
  it('offers nothing on an account PayMe have not provisioned it on', () => {
    expect(invoiceOffer(REAL_ACCOUNT)).toBeNull();
    expect(invoiceOffer([])).toBeNull();
  });

  it('finds the service under either of the two names PayMe publish', () => {
    for (const type of ['Invoice', 'InvoicingService', 'invoice', ' INVOICE ']) {
      const out = invoiceOffer([...REAL_ACCOUNT, svc({ id: 'inv', type, periodicAgorot: 1500, usageAgorot: 30 })]);
      expect(out, type).not.toBeNull();
      expect(out!.serviceId).toBe('inv');
    }
  });

  /** At cost means PayMe's number reaches the screen unchanged — no rounding, no floor, no ₪15
   *  written anywhere in this repo. */
  it('passes the processor\'s own prices through untouched', () => {
    const out = invoiceOffer([svc({ id: 'inv', type: 'Invoice', periodicAgorot: 1500, usageAgorot: 30 })]);
    expect(out).toEqual({ serviceId: 'inv', active: false, monthlyAgorot: 1500, perDocumentAgorot: 30 });
  });

  it('reports whether it is on', () => {
    const on = invoiceOffer([svc({ id: 'inv', type: 'Invoice', active: true })]);
    expect(on!.active).toBe(true);
  });

  /**
   * PayMe's list carries near-duplicates — three rows called `חשבון סליקה` sit on our merchants —
   * so two invoicing rows are possible. The ACTIVE one wins, because that is the row the seller is
   * being billed for and therefore the one a switch-off must target; picking the other would leave
   * him paying for a service the screen says he turned off.
   */
  it('prefers the ACTIVE row when the account carries two', () => {
    const out = invoiceOffer([
      svc({ id: 'off', type: 'Invoice', active: false, periodicAgorot: 1500 }),
      svc({ id: 'on', type: 'Invoice', active: true, periodicAgorot: 1900 }),
    ]);
    expect(out!.serviceId).toBe('on');
    expect(out!.monthlyAgorot).toBe(1900);
  });

  it('is stable on two INACTIVE rows rather than picking by chance', () => {
    const list = [svc({ id: 'first', type: 'Invoice' }), svc({ id: 'second', type: 'Invoice' })];
    expect(invoiceOffer(list)!.serviceId).toBe('first');
    expect(invoiceOffer(list)!.serviceId).toBe('first');
  });
});
