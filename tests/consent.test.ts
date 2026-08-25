/**
 * The cookie arrangement, and the two opposite ways it breaks silently.
 *
 * **This is the Israeli model** (`lib/consent.ts`, `docs/legal-privacy-accessibility.md` §4):
 * Israeli law has no cookie-banner duty and no opt-in requirement, and consent may be implied from
 * a visitor's conduct where the privacy policy discloses clearly. So cookies run from the first
 * visit, a notice says so, and the off-switch lives in the cookies clause of `/privacy`. A first
 * version of this feature implemented the European opt-in shape instead; the owner corrected it in
 * the same session (*"הלכת רחוק מדי"*, memory `feedback_israeli_law_not_european`).
 *
 * **Both failure directions are silent, which is the whole reason for this file.**
 *
 *   *Too strict* — read "no preference recorded" as "denied" and the site is back to opt-in. Nothing
 *   errors. The tags simply stop for everyone who never clicked, the seller dashboards fill with
 *   zeroes, and the cause is a `??` that went missing. That is what the `effectiveConsent` group
 *   below pins.
 *
 *   *Too loose* — let the off-switch disappear, or let the disclosure thin out, and the arrangement
 *   loses the thing that makes implied consent lawful rather than merely customary. Nothing errors
 *   there either; the site just quietly stops having a basis. That is what the last group pins,
 *   from BOTH sides: the notice bar must carry no off-switch (the owner asked that turning cookies
 *   off not be an easy click) and `/privacy` must carry one (that is the floor, and it does not
 *   move).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSENT_ALL,
  CONSENT_NONE,
  consentModeSignal,
  effectiveConsent,
  mayLoadAdPixel,
  mayLoadTagManager,
  parseConsent,
  serializeConsent,
} from '../src/lib/consent.js';
import { AD_PIXEL_ORIGIN, TAG_MANAGER_ORIGIN, gtmHeadScript, metaPixelScript } from '../src/lib/tag-bootstrap.js';
import { contentSecurityPolicy } from '../src/lib/csp.js';

const read = (p: string): string => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

describe('a visitor who has expressed no preference', () => {
  it('is SHOWN the notice — that is what a null parse means', () => {
    expect(parseConsent(undefined)).toBeNull();
    expect(parseConsent('')).toBeNull();
  });

  it('is nevertheless treated as PERMITTING — the Israeli model in one line', () => {
    // Collapse this into `parseConsent` and the site becomes opt-in with nothing failing.
    expect(effectiveConsent(null)).toEqual(CONSENT_ALL);
    expect(mayLoadTagManager(null)).toBe(true);
    expect(mayLoadAdPixel(null)).toBe(true);
  });

  it('signals `granted` to Google too, so both gates agree', () => {
    // Signalling denied while the loader still runs is the worst of both: the tag loads, costs the
    // page its weight, and records nothing.
    expect(consentModeSignal(null)).toEqual({
      analytics_storage: 'granted',
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
    });
  });
});

describe('a recorded preference is honoured exactly', () => {
  it('everything off stops both tags', () => {
    expect(mayLoadTagManager(CONSENT_NONE)).toBe(false);
    expect(mayLoadAdPixel(CONSENT_NONE)).toBe(false);
  });

  it('measurement on, advertising off still loads the container but denies ads', () => {
    // GTM is a CONTAINER serving both, so it loads — and Consent Mode is what stops the ad half.
    // Getting this pair wrong makes the setting a lie the day a remarketing tag is added.
    const c = { analytics: true, ads: false };
    expect(mayLoadTagManager(c)).toBe(true);
    expect(mayLoadAdPixel(c)).toBe(false);
    expect(consentModeSignal(c)).toMatchObject({ analytics_storage: 'granted', ad_storage: 'denied' });
  });

  it('survives a round trip through the cookie', () => {
    for (const c of [CONSENT_ALL, CONSENT_NONE, { analytics: true, ads: false }, { analytics: false, ads: true }]) {
      expect(parseConsent(serializeConsent(c))).toEqual(c);
    }
  });

  it('a malformed or previous-version cookie re-notifies rather than flipping the gate', () => {
    // The safe direction for a NOTICE is to show it again; the safe direction for the GATE is to
    // keep permitting. Both follow from `null`, which is why they are two functions.
    for (const junk of ['', 'yes', 'v0.a1.d1', 'v99.a1.d1', 'v1.a2.d1', '<script>', 'v1.a1']) {
      expect(parseConsent(junk), junk).toBeNull();
      expect(mayLoadTagManager(parseConsent(junk)), junk).toBe(true);
    }
  });
});

describe('the loaders point at hosts the CSP actually allows', () => {
  // A loader aimed at a host `script-src` does not list is a tag that silently never loads, and
  // "the ads are not recording anything" is not a symptom anybody traces back to a header.
  const scriptSrc = contentSecurityPolicy();

  it.each([['tag manager', TAG_MANAGER_ORIGIN], ['ad pixel', AD_PIXEL_ORIGIN]])(
    '%s origin is in script-src', (_n, origin) => {
      expect(scriptSrc).toContain(origin);
    });

  it('the snippets load from those origins and nowhere else', () => {
    expect(gtmHeadScript('GTM-TEST')).toContain(`${TAG_MANAGER_ORIGIN}/gtm.js`);
    expect(metaPixelScript('123')).toContain(`${AD_PIXEL_ORIGIN}/en_US/fbevents.js`);
  });
});

describe('where the off-switch is, and where it is NOT', () => {
  const notice = read('src/components/ConsentBanner.astro');
  const prefs = read('src/components/ConsentPreferences.astro');
  const privacy = read('src/pages/privacy.astro');
  const footer = read('src/components/Footer.astro');

  it('the notice bar carries no off-switch — it informs and closes', () => {
    // Owner, 2026-08-25: *"שלא יהיה שם כפתור כיבוי (כל עוד זה חוקי) פשוט שקל ללחוץ עליו"*.
    expect(notice).not.toContain('consent-analytics');
    expect(notice).not.toContain('consent-ads');
    expect(notice).not.toContain('consent-save');
  });

  it('but it does link the policy, which is what keeps it a notice', () => {
    expect(notice, 'a notice that points nowhere is not a disclosure').toContain('href="/privacy"');
  });

  it('the off-switch EXISTS, on /privacy, inside the clause that explains it', () => {
    // This is the floor and it does not move: implied consent needs the control genuinely
    // reachable. "Not prominent" is the goal; "not available" is the version that fails.
    expect(prefs).toContain('consent-analytics');
    expect(prefs).toContain('consent-ads');
    expect(prefs).toContain('consent-save');
    expect(privacy, '/privacy must render the control').toContain('ConsentPreferences');
  });

  it('and /privacy is linked from every page, which is how it is reached', () => {
    expect(footer).toContain('href="/privacy"');
  });

  it('the cookies clause still discloses that the tags run from the first visit', () => {
    // Implied consent is only consent when what is implied was published. Thinning this sentence
    // does not tidy the page; it removes the basis on which the cookies run at all.
    expect(privacy).toContain('מהכניסה הראשונה');
  });
});
