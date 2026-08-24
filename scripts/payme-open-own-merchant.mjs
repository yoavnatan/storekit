#!/usr/bin/env node
/**
 * Open OUR OWN merchant account at PayMe, and — the whole point — keep what it hands back.
 *
 * ── Why this exists ──
 * The platform is a PARTNER and a MERCHANT, and the two are different roles: as partner we onboard
 * sellers, and as merchant we take cards for things we sell directly — the delivery leg of a cart,
 * and the seller's own monthly subscription. The partner identity cannot receive money at all
 * (`174`, measured — `docs/payme-sandbox-notes.md` §15), so that merchant account is not optional.
 *
 * One was opened on 2026-08-23 (§18) and **its keys were not stored**. `create-seller` returns
 * `seller_public_key`, `seller_payme_secret` and the signup link EXACTLY ONCE, and neither
 * `get-sellers` nor `update-seller` returns any of them — measured, twice. Without the public key
 * we cannot draw Hosted Fields on our own account, which is why a seller's card cannot be taken on
 * the page and the subscription has to hand him off to PayMe's own payment page.
 *
 * That handoff is the hole the owner named (2026-08-24): the week between deciding and paying is a
 * week to change his mind, and the fix is to hold his CARD from the moment he decides — a token,
 * which charges nothing — and open the subscription against it when PayMe approve the business.
 * That needs Hosted Fields. Which needs this key.
 *
 * ── What it does, and what it deliberately does not ──
 * One `create-seller`, printed in full, with the three unrecoverable values called out. It writes
 * NOTHING: putting a value in `.env` is the owner's, and a script that edits it is a script that can
 * corrupt it. It also refuses anything but the sandbox, for the reason the probe does — the
 * environment is shared with PayMe's other partners and has no delete, so every run of this leaves a
 * permanent row.
 *
 *   node scripts/payme-open-own-merchant.mjs          what it WOULD send, and nothing else
 *   node scripts/payme-open-own-merchant.mjs --create  actually opens one
 *
 * The dry run is the default on purpose: this is the one script here whose effect cannot be undone.
 */
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const KEY = env.PAYME_CLIENT_KEY;
const BASE = env.PAYME_BASE_URL || 'https://sandbox.payme.io/api/';
if (!KEY) { console.error('no PAYME_CLIENT_KEY in .env'); process.exit(1); }
if (!BASE.includes('sandbox')) { console.error('REFUSING: this is not the sandbox. Opening the production account is a deliberate, once-ever act — do it knowingly, not through a dev script.'); process.exit(1); }

/**
 * PayMe's own documented test values (`docs/payme-sandbox-notes.md`), because this is the sandbox
 * and a real ת.ז has no business in an environment shared with other partners and with no delete.
 * The production account is opened with the company's real details, once, by a person.
 *
 * `seller_inc: 3` is חברה בע"מ, from their Israeli list — the platform is a company, and 2 (עוסק
 * מורשה) would carry §19's rule that the business number must equal the owner's ת.ז.
 */
const BUSINESS = {
  seller_first_name: 'Dezabin',
  seller_last_name: 'Platform',
  seller_social_id: '100000009',
  seller_birthdate: '01/01/1990',
  seller_social_id_issued: '01/06/2018',
  seller_gender: 0,
  seller_email: 'random@paymeservice.com',
  seller_phone: '0500000002',
  seller_bank_code: 54,
  seller_bank_branch: 123,
  seller_bank_account_number: '123456',
  seller_description: 'Dezabin — platform merchant: delivery and seller subscriptions',
  seller_site_url: 'https://dezabin.co.il',
  seller_person_business_type: '10200',
  seller_inc: 3,
  seller_merchant_name: 'Dezabin',
  seller_registration_date: '15/01/2020',
  seller_retail_type: 1,
  seller_address_city: 'תל אביב',
  seller_address_street: 'הרצל',
  seller_address_street_number: '1',
  seller_address_country: 'IL',
};

if (!process.argv.includes('--create')) {
  console.log('DRY RUN — nothing was sent. What a --create would post to create-seller:\n');
  console.log(JSON.stringify(BUSINESS, null, 1));
  console.log('\nRun again with --create to actually open it. It cannot be deleted afterwards.');
  process.exit(0);
}

const res = await fetch(`${BASE}create-seller`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ payme_client_key: KEY, ...BUSINESS }),
});
const body = await res.json().catch(() => null);
if (!body || body.status_code !== 0) {
  console.error('REFUSED:', body?.status_error_details ?? `HTTP ${res.status}`, body?.status_error_code ?? '', body?.status_additional_info ?? '');
  process.exit(1);
}

// `seller_public_key` is an OBJECT — `{ uuid, description, is_active }` — confirmed by the real
// response in §20. The uuid is the value Hosted Fields is initialised with.
const publicKey = typeof body.seller_public_key === 'object' && body.seller_public_key
  ? body.seller_public_key.uuid
  : body.seller_public_key;

console.log('\n✅ opened. THESE THREE COME BACK ONCE AND NEVER AGAIN — put the first two in .env now:\n');
console.log(`PAYME_DELIVERY_MERCHANT_ID=${body.seller_payme_id}`);
console.log(`PAYME_OWN_PUBLIC_KEY=${publicKey}`);
console.log(`\n(callback secret, for reference — nothing reads it for our own account yet: ${body.seller_payme_secret})`);
console.log(`(signup link: ${body.seller_dashboard_signup_link ?? '—'})`);
