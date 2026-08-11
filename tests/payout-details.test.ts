/**
 * Where a seller's money is sent — the validation, the write, and the join between them and the
 * payout run.
 *
 * The last one is the point of the file. Three of the four bank fields, or a form that saved but
 * left the columns the run reads untouched, both look fine on screen and both produce the same
 * silent outcome: a seller who filled everything in and is never paid. So the final block does not
 * assert on the response — it runs `runPayouts` before and after the save and asserts the answer
 * changed from "skipped, no bank" to a real payout row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { APIContext } from 'astro';
import { query } from '../src/lib/db.js';
import { parsePayoutDetails, hasPayableBank, maskedBankLine } from '../src/lib/payout-details.js';

const SELLER_ID = '11111111-1111-4111-8111-0000000000b1';
const STORE_ID = '22222222-2222-4222-8222-0000000000b1';
const PRODUCT_ID = '33333333-3333-4333-8333-0000000000b1';
const SLUG = 'payout-shop';
const TODAY = '2026-08-10';

let SESSION: string | null = SELLER_ID;
vi.mock('../src/lib/seller-auth.js', async () => ({
  // Everything real except who is calling — the write under test lives in this module, and stubbing
  // it away would leave the route asserting against a mock of itself.
  ...(await vi.importActual<typeof import('../src/lib/seller-auth')>('../src/lib/seller-auth')),
  getSellerSession: () => SESSION,
}));

const { POST } = await import('../src/pages/api/seller/payout-details.js');
const { getSellerById } = await import('../src/lib/seller-auth.js');
const { runPayouts } = await import('../src/lib/payout-run.js');

function ctx(body: unknown): APIContext {
  return {
    request: new Request('http://localhost/api/seller/payout-details', { method: 'POST', body: JSON.stringify(body) }),
    cookies: { get: () => undefined } as unknown as APIContext['cookies'],
  } as APIContext;
}

const FULL = { bankCode: '12', bankBranch: '345', bankAccount: '123456', bankAccountHolder: 'חנות בע״מ' };

describe('the bank block is all four fields or none', () => {
  it('accepts the four, stripping whatever punctuation they were pasted with', () => {
    const r = parsePayoutDetails({ bankCode: '12', bankBranch: '3-45', bankAccount: '12 34 56', bankAccountHolder: '  חנות   בע״מ ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.details).toMatchObject({ bankCode: '12', bankBranch: '345', bankAccount: '123456', bankAccountHolder: 'חנות בע״מ' });
  });

  it('refuses three of four, and names the one that is missing', () => {
    const r = parsePayoutDetails({ ...FULL, bankAccountHolder: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The field name is what lets the form focus the right box instead of printing one message
    // above six inputs.
    expect(r.field).toBe('bankAccountHolder');
  });

  it('accepts none at all — a seller with no bank yet is a NORMAL state, not an error', () => {
    const r = parsePayoutDetails({ businessId: '123456789' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(hasPayableBank(r.details)).toBe(false);
  });
});

describe('the business identity', () => {
  it('takes nine digits and refuses anything shorter', () => {
    expect(parsePayoutDetails({ businessId: '12345678' }).ok).toBe(false);
    expect(parsePayoutDetails({ businessId: '123456789' }).ok).toBe(true);
  });

  it('refuses a type outside the three the invoice layer knows', () => {
    // `vat.ts#chargesVat` reads this to decide whether the seller's invoice carries VAT at all, so
    // a value it does not recognise would silently answer "no".
    expect(parsePayoutDetails({ businessType: 'freelancer' }).ok).toBe(false);
    expect(parsePayoutDetails({ businessType: 'exempt' }).ok).toBe(true);
  });
});

describe('only one module decides whether a transfer can be made', () => {
  // The repo's own most repeated bug class: a rule that is correct in most places and missing from
  // one (safe-redirect, secret-compare). "All four bank fields" now has two readers — the payout
  // run and the seller's own screen — and a third hand-rolled copy would show a banner saying "add
  // your bank details" to a seller the run is happily paying, or the reverse.
  it('nobody hand-rolls the all-four check', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|astro)$/.test(e.name) ? [join(dir, e.name)] : []));

    const offenders = walk('src')
      .filter((f) => !f.endsWith('payout-details.ts'))
      .filter((f) => {
        const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        // A file that names the holder AND another bank field in one boolean expression is deciding
        // this for itself. Reading a single field (the form's `value=`, the row mapper) is fine.
        return /bankAccountHolder[^\n]*&&|&&[^\n]*bankAccountHolder/.test(src);
      });
    expect(offenders, 'use hasPayableBank() from lib/payout-details.ts').toEqual([]);
  });
});

describe('what the seller is shown back', () => {
  it('masks all but the last four digits of the account', () => {
    const line = maskedBankLine({ ...FULL })!;
    expect(line).toContain('3456');
    expect(line).not.toContain('123456');
  });

  it('says nothing at all when the account is incomplete', () => {
    expect(maskedBankLine({ bankCode: '12' })).toBeNull();
  });
});

async function seed(): Promise<void> {
  SESSION = SELLER_ID;
  await query('DELETE FROM seller_payouts WHERE seller_id = $1', [SELLER_ID]);
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM orders');
  await query('DELETE FROM store_products WHERE id = $1', [PRODUCT_ID]);
  await query('DELETE FROM stores WHERE id = $1', [STORE_ID]);
  await query('DELETE FROM sellers WHERE id = $1', [SELLER_ID]);
  await query(
    `INSERT INTO sellers (id, name, email, password_hash, created_at) VALUES ($1, 'Payee', $2, '', now())`,
    [SELLER_ID, `payee-${SELLER_ID}@example.com`],
  );
  await query(
    `INSERT INTO stores (id, seller_id, slug, name, tagline, description, colors, created_at)
     VALUES ($1, $2, $3, 'Payout Shop', '', '', '{"primary":"#000","accent":"#111"}'::jsonb, now())`,
    [STORE_ID, SELLER_ID, SLUG],
  );
}

/** One delivered order, long enough ago that its hold has certainly expired — so the ONLY thing
 *  standing between this seller and a payout is the bank form. */
async function seedReleasedOrder(): Promise<void> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status, paid_at, delivered_at, created_at)
     VALUES ($1, 'B', 'b@example.com', 500000, 'paid', 'delivered', now() - interval '200 days', now() - interval '190 days', now() - interval '200 days')`,
    [id],
  );
  await query(
    `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot)
     VALUES ($1, $2, 'Payout Shop', 500000, 0)`,
    [id, SLUG],
  );
}

beforeEach(seed);

describe('the route', () => {
  it('refuses a caller with no session', async () => {
    SESSION = null;
    expect((await POST(ctx(FULL))).status).toBe(401);
  });

  it('saves the four fields against the SESSION\'s account, never an id from the body', async () => {
    // A `sellerId` in the body is simply not read — the route has no parameter for one. Sent here
    // so the assertion is about that, and not about a field nobody tried to pass.
    const res = await POST(ctx({ ...FULL, sellerId: crypto.randomUUID(), businessId: '123456789', businessType: 'licensed' }));
    expect(res.status).toBe(200);

    const saved = (await getSellerById(SELLER_ID))!;
    expect(hasPayableBank(saved)).toBe(true);
    expect(saved.businessType).toBe('licensed');
  });

  it('clears the account when the fields come back empty, rather than keeping the old one', async () => {
    await POST(ctx(FULL));
    await POST(ctx({ bankCode: '', bankBranch: '', bankAccount: '', bankAccountHolder: '' }));
    // The `COALESCE` shape `updateSeller` uses would have kept the previous account here, and the
    // next payout run would have sent money to it. That is why this write is its own function.
    expect(hasPayableBank((await getSellerById(SELLER_ID))!)).toBe(false);
  });

  it('refuses a half-filled form and writes nothing', async () => {
    await POST(ctx(FULL));
    const res = await POST(ctx({ ...FULL, bankAccount: '' }));
    expect(res.status).toBe(400);
    // Still the ORIGINAL account: a refusal that had half-written would leave a payout aimed at a
    // branch with no account number.
    expect((await getSellerById(SELLER_ID))!.bankAccount).toBe(FULL.bankAccount);
  });

  it('tells the seller their payout account moved', async () => {
    await POST(ctx(FULL));
    const { rows } = await query<{ title: string }>(
      'SELECT title FROM notifications WHERE user_id = $1', [SELLER_ID]);
    expect(rows.map((r) => r.title)).toContain('פרטי חשבון הבנק עודכנו');
  });
});

/**
 * There is ONE place bank details are collected — the payments tab — and this guard is what keeps
 * it that way by construction rather than by memory.
 *
 * A second entry point was briefly added to the store-opening card and removed the same day (owner,
 * 2026-08-11: *"בפתיחת חנות אין בלוקים מקופלים"*). The guard is kept because the risk it names is
 * real whichever surface asks: `parsePayoutDetails` is what makes the four bank fields
 * all-or-nothing, and a writer that skipped it could store three of them — after which
 * `hasPayableBank` reads "not ready" forever, on a form the seller believes they completed.
 * It scans the tree rather than naming call sites, so a new one is covered the day it exists.
 */
describe('nothing writes bank details it did not validate', () => {
  it('every caller of updateSellerPayoutDetails also calls parsePayoutDetails', () => {
    const root = path.resolve(__dirname, '../src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|astro)$/.test(entry.name)) continue;
        // The module that DEFINES the write is not a caller of it.
        if (full.endsWith(path.join('lib', 'seller-auth.ts'))) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (!src.includes('updateSellerPayoutDetails(')) continue;
        if (!src.includes('parsePayoutDetails(')) offenders.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(offenders, 'validate through parsePayoutDetails before writing bank details').toEqual([]);
  });

});

describe('the form and the payout run are joined up', () => {
  it('turns "skipped, no bank details" into a real payout', async () => {
    await seedReleasedOrder();

    const before = await runPayouts(TODAY);
    expect(before.skippedNoBank).toBe(1);
    expect(before.created).toBe(0);

    expect((await POST(ctx(FULL))).status).toBe(200);

    // A different period key, because the first run's `periodKey` is the same one and a payout is
    // UNIQUE per (seller, period) — the run above created nothing, so this is the first.
    const after = await runPayouts(TODAY);
    expect(after.skippedNoBank).toBe(0);
    expect(after.created).toBe(1);
    expect(after.totalAgorot).toBeGreaterThan(0);
  });
});
