/**
 * The details PayMe need to open a seller's clearing account.
 *
 * Every case here is a way a real merchant account gets opened against the wrong facts about a real
 * person — which surfaces weeks later as a KYC mismatch at underwriting, not as an error anybody
 * sees today.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeMerchantKyc, missingMerchantKyc, isCompleteMerchantKyc, paymeDate, paymeIncorporation,
  MERCHANT_KYC_FIELDS, MERCHANT_CATEGORY_FALLBACK,
} from '../src/lib/merchant-kyc.js';

const COMPLETE = {
  ownerSocialId: '999999999',
  ownerBirthdate: '1989-05-06',
  ownerSocialIdIssued: '2000-01-01',
  ownerGender: 0,
  ownerPhone: '0540123456',
  businessRegisteredOn: '2020-05-06',
  businessCategory: '5999',
  businessCity: 'תל אביב',
  businessStreet: 'רוטשילד',
  businessStreetNumber: '45',
};

describe('dates', () => {
  it('converts ISO to PayMe\'s DD/MM/YYYY', () => {
    // `06/05/1989` in their format is 6 May. An ISO-minded implementation sending `1989-05-06`
    // either fails the call or — worse, if their parser is lenient — opens the account against the
    // wrong birth date.
    expect(paymeDate('1989-05-06')).toBe('06/05/1989');
    expect(paymeDate('2020-12-31')).toBe('31/12/2020');
  });

  it('reformats by slicing, never through a Date — a timezone would move the day', () => {
    // `new Date('1989-05-06')` is midnight UTC; rendered in Israel local time it is 5 May. A birth
    // date one day early looks like a typo and is a KYC mismatch.
    expect(paymeDate('2026-01-01')).toBe('01/01/2026');
    expect(paymeDate('2026-12-31')).toBe('31/12/2026');
  });

  it('rejects a day that does not exist rather than storing it', () => {
    // `/^\d{4}-\d{2}-\d{2}$/` accepts all three of these. `isDayISO` does not, which is the whole
    // reason this module does not roll its own shape check.
    for (const bad of ['2026-02-30', '2026-13-01', '9999-99-99', '0000-00-00', '', 'yesterday']) {
      expect(normalizeMerchantKyc({ ...COMPLETE, ownerBirthdate: bad }).ownerBirthdate, bad).toBeUndefined();
    }
  });
});

describe('normalising a submission', () => {
  it('accepts a complete one unchanged', () => {
    expect(normalizeMerchantKyc(COMPLETE)).toEqual(COMPLETE);
    expect(isCompleteMerchantKyc(normalizeMerchantKyc(COMPLETE))).toBe(true);
  });

  it('drops a bad field instead of refusing the whole form', () => {
    // Refusing everything would lose the nine fields the seller did get right, and he would have to
    // type them again to find out which one was wrong.
    const out = normalizeMerchantKyc({ ...COMPLETE, ownerSocialId: '12' });
    expect(out.ownerSocialId).toBeUndefined();
    expect(out.businessCity).toBe('תל אביב');
    expect(missingMerchantKyc(out)).toEqual(['ownerSocialId']);
  });

  it('never records a skipped gender as male', () => {
    // `Number('')` is 0, which is PayMe's value for male. A truthiness-free `=== 0 || === 1` is
    // what stops every seller who ignored the question being filed as a man.
    for (const skipped of ['', undefined, null, 'x', 2, -1]) {
      expect(normalizeMerchantKyc({ ...COMPLETE, ownerGender: skipped }).ownerGender, String(skipped)).toBeUndefined();
    }
    expect(normalizeMerchantKyc({ ...COMPLETE, ownerGender: '1' }).ownerGender).toBe(1);
    expect(normalizeMerchantKyc({ ...COMPLETE, ownerGender: 0 }).ownerGender).toBe(0);
  });

  it('normalises a mobile however it was typed', () => {
    // One seller pastes `+972-54-…`, another types `054 012 3456`. Both name the same phone, and
    // PayMe must receive one spelling.
    for (const typed of ['0540123456', '054-012-3456', '+972-54-012-3456', '972540123456', '054 012 3456']) {
      expect(normalizeMerchantKyc({ ...COMPLETE, ownerPhone: typed }).ownerPhone, typed).toBe('0540123456');
    }
  });

  it('rejects a landline — PayMe require a mobile', () => {
    expect(normalizeMerchantKyc({ ...COMPLETE, ownerPhone: '031234567' }).ownerPhone).toBeUndefined();
  });

  it('accepts a nine-digit id without judging its check digit', () => {
    // `payout-details.ts`'s rule, and it applies twice over here: a false rejection is
    // unrecoverable from the seller's side and would block a correct number.
    expect(normalizeMerchantKyc({ ...COMPLETE, ownerSocialId: '123456789' }).ownerSocialId).toBe('123456789');
    expect(normalizeMerchantKyc({ ...COMPLETE, ownerSocialId: '12345678' }).ownerSocialId).toBeUndefined();
  });

  it('falls back to a real MCC rather than leaving a seller blocked over a code he never saw', () => {
    expect(normalizeMerchantKyc({ ...COMPLETE, businessCategory: '' }).businessCategory).toBe(MERCHANT_CATEGORY_FALLBACK);
    expect(missingMerchantKyc(normalizeMerchantKyc({ ...COMPLETE, businessCategory: '' }))).toEqual([]);
  });

  it('reads nothing at all out of junk', () => {
    for (const junk of [null, undefined, 'string', 42, []]) {
      expect(missingMerchantKyc(normalizeMerchantKyc(junk)).length, String(junk))
        .toBe(MERCHANT_KYC_FIELDS.length - 1);   // the category falls back; nothing else can
    }
  });
});

describe('missing fields', () => {
  it('lists everything absent, in the order a form asks it', () => {
    expect(missingMerchantKyc({})).toEqual([...MERCHANT_KYC_FIELDS]);
    expect(missingMerchantKyc(null)).toEqual([...MERCHANT_KYC_FIELDS]);
  });

  it('treats an empty string as missing, not as an answer', () => {
    expect(missingMerchantKyc({ ...COMPLETE, businessCity: '' } as never)).toEqual(['businessCity']);
  });
});

describe('incorporation type', () => {
  it('maps our three business types onto PayMe\'s enum', () => {
    expect(paymeIncorporation('company')).toBe(2);   // Licensed Company
    expect(paymeIncorporation('exempt')).toBe(5);    // Exempt Company
    expect(paymeIncorporation('licensed')).toBe(1);  // Sole proprietorship
  });

  it('never falls back to `0` — a private individual is not a seller this platform has', () => {
    // Sellers are registered businesses only (AI_INSTRUCTIONS → Business model), and PayMe's `0` is
    // the one category we have contractually excluded. An unknown value is a sole trader, the
    // commonest case, not a category we do not accept.
    expect(paymeIncorporation(undefined)).toBe(1);
    expect(paymeIncorporation('something-else')).toBe(1);
  });
});
