/**
 * The seller settling the buyer's invoice — the surface that replaced "the platform issues it".
 *
 * Two things are worth a test here and neither is about tax. One: the order id arrives from a
 * client, so the seller id in the WHERE is the only thing standing between a seller and another
 * seller's order row — the "an id is not a permission" class, on a new surface. Two: the uploaded
 * URL also arrives from a client, and a link the platform shows to a buyer as "your invoice" must be
 * a file in our own storage rather than wherever the request said.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { planBuyerInvoice } from '../src/lib/invoicing/index.js';
import {
  markBuyerInvoiceProvided,
  getBuyerInvoiceStates,
  getBuyerInvoiceForOrder,
  isStoredDocumentUrl,
} from '../src/lib/invoicing/buyer-invoice.js';
import type { Order } from '../src/lib/orders.js';

// The build normally supplies this; Vitest does not load `.env`, so it is set here rather than left
// undefined — an unset cloud makes `isStoredDocumentUrl` refuse everything, which would let every
// case below pass while proving nothing about what it ACCEPTS.
const CLOUD = 'test-cloud';
process.env.PUBLIC_CLOUDINARY_CLOUD_NAME = CLOUD;

const FILE = `https://res.cloudinary.com/${CLOUD}/image/upload/v1/invoice.jpg`;

async function makeSeller(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO sellers (id, name, email, password_hash, business_type, created_at)
     VALUES ($1, 'Inv Test', $2, '', 'licensed', now())`,
    [id, `bi-${id}@example.com`],
  );
  return id;
}

async function makeOrder(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status)
     VALUES ($1, 'Buyer', 'b@example.com', 12000, 'paid', 'pending')`,
    [id],
  );
  return id;
}

function orderWith(id: string, subtotalAgorot: number): Order {
  return {
    id,
    buyerName: 'Buyer', buyerEmail: 'b@example.com', buyerPhone: '',
    buyerAddress: { city: '', street: '' },
    items: [],
    storeSubtotals: { shop: { subtotalAgorot, shippingAgorot: 2_000 } },
    shippingAgorot: 2_000, totalAgorot: subtotalAgorot + 2_000,
    paymentStatus: 'paid', shippingStatus: 'pending',
    createdAt: '', updatedAt: '',
  } as unknown as Order;
}

/** A paid order slice with its invoice still owed — what `checkout.ts` leaves behind. */
async function owedInvoice(): Promise<{ sellerId: string; orderId: string }> {
  const sellerId = await makeSeller();
  const orderId = await makeOrder();
  await planBuyerInvoice(orderWith(orderId, 10_000), 'shop', { id: sellerId, businessType: 'licensed' });
  return { sellerId, orderId };
}

describe('only the seller who owns the order can settle it', () => {
  it('settles his own order', async () => {
    const { sellerId, orderId } = await owedInvoice();
    const state = await markBuyerInvoiceProvided(sellerId, orderId, { mode: 'handover' });

    expect(state).not.toBeNull();
    expect(state!.status).toBe('issued');
    expect(state!.mode).toBe('handover');
    expect(state!.documentUrl).toBeNull();
    expect(state!.providedAt).not.toBeNull();
  });

  it("answers null for ANOTHER seller's order, and leaves it untouched", async () => {
    const { orderId } = await owedInvoice();
    const intruder = await makeSeller();

    expect(await markBuyerInvoiceProvided(intruder, orderId, { mode: 'handover' })).toBeNull();

    // The point is not the null — it is that the row is still owed. A write that "failed" but landed
    // is the shape of this bug class that a return-value assertion alone would miss.
    const [state] = await getBuyerInvoiceForOrder(orderId);
    expect(state.status).toBe('pending');
    expect(state.mode).toBeNull();
  });

  it('answers null for an order that does not exist — same answer, nothing probeable', async () => {
    const sellerId = await makeSeller();
    expect(await markBuyerInvoiceProvided(sellerId, crypto.randomUUID(), { mode: 'handover' })).toBeNull();
  });

  it('refuses a malformed id rather than reaching the database with it', async () => {
    const { sellerId } = await owedInvoice();
    expect(await markBuyerInvoiceProvided(sellerId, 'not-a-uuid', { mode: 'handover' })).toBeNull();
    expect(await markBuyerInvoiceProvided('not-a-uuid', crypto.randomUUID(), { mode: 'handover' })).toBeNull();
  });
});

describe('an uploaded invoice is a file in OUR storage', () => {
  it('accepts a Cloudinary URL and shows it to the buyer', async () => {
    const { sellerId, orderId } = await owedInvoice();
    const state = await markBuyerInvoiceProvided(sellerId, orderId, { mode: 'upload', documentUrl: FILE });

    expect(state!.mode).toBe('upload');
    expect(state!.documentUrl).toBe(FILE);
    expect((await getBuyerInvoiceForOrder(orderId))[0].documentUrl).toBe(FILE);
  });

  it.each([
    ['another host', 'https://evil.example.com/invoice.pdf'],
    ['a lookalike host', 'https://res.cloudinary.com.evil.example.com/x.pdf'],
    ['plain http', 'http://res.cloudinary.com/demo/raw/upload/v1/invoice.pdf'],
    ['a javascript: url', 'javascript:alert(1)'],
    ['nonsense', 'not a url at all'],
    ['nothing', ''],
    // The two that get past a host-only check, which is why the host is not the check.
    ["ANOTHER Cloudinary account", 'https://res.cloudinary.com/someone-else/image/upload/v1/x.jpg'],
    ['our own cloud used as a PROXY for a remote address',
      `https://res.cloudinary.com/${CLOUD}/image/fetch/https://evil.example.com/x.jpg`],
  ])('refuses %s, and the invoice stays owed', async (_label, url) => {
    const { sellerId, orderId } = await owedInvoice();

    expect(await markBuyerInvoiceProvided(sellerId, orderId, { mode: 'upload', documentUrl: url })).toBeNull();
    expect((await getBuyerInvoiceForOrder(orderId))[0].status).toBe('pending');
  });

  it('judges the URL the same way on its own', () => {
    expect(isStoredDocumentUrl(FILE)).toBe(true);
    expect(isStoredDocumentUrl('https://res.cloudinary.com.evil.example.com/x.pdf')).toBe(false);
  });

  it('accepts a RAW upload, which is what a PDF invoice actually is', async () => {
    // `cloudinaryUploadInvoice` posts to /raw/upload so the buyer opens the seller's own bytes
    // rather than something Cloudinary rendered from them. The check must not be pinned to `image`.
    const pdf = `https://res.cloudinary.com/${CLOUD}/raw/upload/v1/invoice.pdf`;
    expect(isStoredDocumentUrl(pdf)).toBe(true);

    const { sellerId, orderId } = await owedInvoice();
    const state = await markBuyerInvoiceProvided(sellerId, orderId, { mode: 'upload', documentUrl: pdf });
    expect(state!.documentUrl).toBe(pdf);
  });

  it('a handover carries no file even when a URL is passed', async () => {
    const { sellerId, orderId } = await owedInvoice();
    const state = await markBuyerInvoiceProvided(sellerId, orderId, { mode: 'handover', documentUrl: FILE });
    expect(state!.documentUrl).toBeNull();
  });
});

describe('correcting an answer', () => {
  it('replaces a handover with the real file, keeping the original settlement time', async () => {
    const { sellerId, orderId } = await owedInvoice();
    const first = await markBuyerInvoiceProvided(sellerId, orderId, { mode: 'handover' });
    const second = await markBuyerInvoiceProvided(sellerId, orderId, { mode: 'upload', documentUrl: FILE });

    expect(second!.mode).toBe('upload');
    expect(second!.documentUrl).toBe(FILE);
    // "When did this stop being outstanding" is not changed by uploading the file afterwards.
    expect(second!.providedAt).toBe(first!.providedAt);
  });
});

describe('the dashboard reads a page at a time', () => {
  it('returns a map for the ids it was given and omits the rest', async () => {
    const { sellerId, orderId } = await owedInvoice();
    const other = await makeOrder();

    const states = await getBuyerInvoiceStates(sellerId, [orderId, other, 'not-a-uuid']);
    expect(states.get(orderId)?.status).toBe('pending');
    expect(states.has(other)).toBe(false);
  });

  it("never returns another seller's row", async () => {
    const { orderId } = await owedInvoice();
    const intruder = await makeSeller();
    expect((await getBuyerInvoiceStates(intruder, [orderId])).size).toBe(0);
  });

  it('stops being owed once it is settled', async () => {
    const { sellerId, orderId } = await owedInvoice();
    expect((await getBuyerInvoiceForOrder(orderId))[0].status).toBe('pending');

    await markBuyerInvoiceProvided(sellerId, orderId, { mode: 'handover' });
    expect((await getBuyerInvoiceForOrder(orderId))[0].status).toBe('issued');
  });
});
