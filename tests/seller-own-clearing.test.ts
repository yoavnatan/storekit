/**
 * The seller's own clearing credentials: that they are stored unreadable, that saving one field
 * does not wipe the others, and that a shop cannot take money on credentials nobody has tested.
 *
 * The three things this asserts are the three ways this feature fails badly rather than visibly:
 * a plaintext API key in a database backup, a seller who corrects his terminal number and silently
 * loses his secret key, and a typo that is discovered by a buyer at checkout instead of by him.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { query, firstRow } from '../src/lib/db.js';
import { sealSecret, openSecret, secretHint } from '../src/lib/secret-box.js';
import { CLEARING_PROVIDERS, connectableProviders, pickCredentials, clearingProvider } from '../src/lib/clearing-providers.js';
import {
  sellerClearingFor,
  saveSellerClearing,
  markClearingVerified,
  canTakePayments,
  forDisplay,
} from '../src/lib/seller-own-clearing.js';

let sellerId: string;

beforeEach(async () => {
  sellerId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`, [
    sellerId,
    `${sellerId}@clearing.test`,
  ]);
});

describe('secret-box', () => {
  it('round-trips', () => {
    expect(openSecret(sealSecret('hunter2'))).toBe('hunter2');
  });

  it('refuses a value somebody edited in the database', () => {
    const sealed = sealSecret('hunter2');
    const parts = sealed.split('.');
    // Flip a BIT of the ciphertext, not a base64 character. The last character of a base64url string
    // can carry unused bits, so two different characters there decode to identical bytes — a first
    // version of this test edited that character and passed only by luck, which would have made it a
    // test that proves nothing. This is the shape a write-capable attacker would use to swap a
    // seller's terminal for their own.
    const bytes = Buffer.from(parts[3], 'base64url');
    bytes[0] ^= 0x01;
    parts[3] = bytes.toString('base64url');
    expect(openSecret(parts.join('.'))).toBeNull();
  });

  it('refuses anything it did not write', () => {
    expect(openSecret('plain-api-key')).toBeNull();
    expect(openSecret('')).toBeNull();
    expect(openSecret(null)).toBeNull();
  });

  it('a hint shows four characters and never the key', () => {
    expect(secretHint('abcd1234wxyz')).toBe('••••wxyz');
    expect(secretHint('abcd1234wxyz')).not.toContain('abcd');
    expect(secretHint('')).toBe('');
  });
});

describe('the provider registry', () => {
  it('offers only providers whose fields came from the vendor', () => {
    for (const p of connectableProviders()) {
      expect(p.fieldsVerified, `${p.id} is offered`).toBe(true);
      expect(p.fields.length, `${p.id} has no fields`).toBeGreaterThan(0);
    }
  });

  it('an unverified provider is listed but has no fields to ask for', () => {
    for (const p of CLEARING_PROVIDERS.filter((x) => !x.fieldsVerified)) {
      expect(p.fields, `${p.id} would ask a seller for guessed fields`).toEqual([]);
    }
  });

  it('drops anything the provider did not ask for', () => {
    const hyp = clearingProvider('hyp')!;
    const picked = pickCredentials(hyp, { masof: '0010131918', apiKey: 'k', passp: 'p', isAdmin: 'yes' });
    expect(Object.keys(picked).sort()).toEqual(['apiKey', 'masof', 'passp']);
  });
});

describe('saving and reading a seller’s credentials', () => {
  it('stores nothing readable in the column', async () => {
    await saveSellerClearing(sellerId, 'hyp', { masof: '0010131918', apiKey: 'SUPER-SECRET-KEY', passp: 'pw' });
    const row = await firstRow<{ credentials: string }>(
      'SELECT credentials FROM seller_clearing_credentials WHERE seller_id = $1',
      [sellerId],
    );
    expect(row!.credentials).not.toContain('SUPER-SECRET-KEY');
    expect(row!.credentials).not.toContain('0010131918');
    expect(row!.credentials.startsWith('v1.')).toBe(true);
  });

  it('reads back what was saved', async () => {
    const saved = await saveSellerClearing(sellerId, 'hyp', { masof: '1', apiKey: 'k', passp: 'p' });
    expect(saved!.credentials).toEqual({ masof: '1', apiKey: 'k', passp: 'p' });
    expect(saved!.missing).toEqual([]);
  });

  it('keeps a secret the seller did not retype', async () => {
    await saveSellerClearing(sellerId, 'hyp', { masof: '1', apiKey: 'k', passp: 'p' });
    // The form renders `••••` for a secret, so an untouched field posts empty. This is the save
    // that would otherwise erase his API key because he fixed a typo in the terminal number.
    const after = await saveSellerClearing(sellerId, 'hyp', { masof: '2', apiKey: '', passp: '' });
    expect(after!.credentials).toEqual({ masof: '2', apiKey: 'k', passp: 'p' });
  });

  it('does not carry one provider’s fields into another', async () => {
    await saveSellerClearing(sellerId, 'hyp', { masof: '1', apiKey: 'k', passp: 'p' });
    const moved = await saveSellerClearing(sellerId, 'payplus', { paymentPageUid: 'u' });
    expect(moved!.provider.id).toBe('payplus');
    expect(moved!.credentials).toEqual({ paymentPageUid: 'u' });
    expect(moved!.missing.sort()).toEqual(['apiKey', 'secretKey']);
  });

  it('refuses a provider we cannot actually talk to yet', async () => {
    expect(await saveSellerClearing(sellerId, 'cardcom', { anything: 'x' })).toBeNull();
    expect(await sellerClearingFor(sellerId)).toBeNull();
  });
});

describe('the gate on taking money', () => {
  it('is closed until the credentials were tested', async () => {
    const saved = await saveSellerClearing(sellerId, 'hyp', { masof: '1', apiKey: 'k', passp: 'p' });
    expect(canTakePayments(saved)).toBe(false);

    await markClearingVerified(sellerId);
    expect(canTakePayments(await sellerClearingFor(sellerId))).toBe(true);
  });

  it('closes again when anything changes', async () => {
    await saveSellerClearing(sellerId, 'hyp', { masof: '1', apiKey: 'k', passp: 'p' });
    await markClearingVerified(sellerId);
    await saveSellerClearing(sellerId, 'hyp', { masof: '9' });
    expect(canTakePayments(await sellerClearingFor(sellerId))).toBe(false);
  });

  it('is closed while a field is still empty', async () => {
    const partial = await saveSellerClearing(sellerId, 'hyp', { masof: '1' });
    expect(partial!.missing.sort()).toEqual(['apiKey', 'passp']);
    expect(canTakePayments(partial)).toBe(false);
  });
});

describe('what a screen is allowed to see', () => {
  it('hands out hints for secrets and never the value', async () => {
    const saved = await saveSellerClearing(sellerId, 'hyp', {
      masof: '0010131918',
      apiKey: 'abcd1234wxyz',
      passp: 'pw',
    });
    const shown = forDisplay(saved);
    expect(shown.apiKey).toEqual({ set: true, hint: '••••wxyz' });
    expect(JSON.stringify(shown)).not.toContain('abcd1234wxyz');
    // A terminal number is not a secret — he has to be able to read it back and check it.
    expect(shown.masof).toEqual({ set: true, hint: '0010131918' });
  });
});
